import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { RedisLockService } from '../redis/redis-lock.service';
import {
  WalletTransaction,
  WalletTransactionType,
} from './wallet-transaction.entity';
import { Wallet } from './wallet.entity';

interface RecordTransactionParams {
  userId: string;
  idempotencyKey: string;
  type: WalletTransactionType;
  amount: bigint;
  balanceAfter: bigint;
  referenceId?: string | null;
}

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    private readonly redisLock: RedisLockService,
  ) {}

  // NOTE: in the real system a wallet row is created by the `user.registered`
  // event (see architecture doc, section 6), not lazily on first bet. This is
  // a simplification until Auth Service and RabbitMQ events exist.
  private async getOrCreateWallet(
    manager: EntityManager,
    userId: string,
  ): Promise<Wallet> {
    const existing = await manager.findOneBy(Wallet, { userId });
    if (existing) {
      return existing;
    }

    const wallet = manager.create(Wallet, { userId, cachedBalance: '1000' });
    return manager.save(wallet);
  }

  // atomic UPDATE ... WHERE version = expectedVersion — this is the actual
  // optimistic lock; result.affected === 0 means someone else won the race
  private async updateBalanceWithVersionCheck(
    manager: EntityManager,
    userId: string,
    newBalance: bigint,
    expectedVersion: number,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(Wallet)
      .set({
        cachedBalance: newBalance.toString(),
        version: () => '"version" + 1',
      })
      .where('userId = :userId AND version = :version', {
        userId,
        version: expectedVersion,
      })
      .execute();

    if (result.affected === 0) {
      throw new ConflictException('Concurrent modification detected, retry');
    }
  }

  // appends one row to the wallet_transactions audit log — shared by every
  // operation type (BET, and later PAYOUT/BONUS/DEPOSIT)
  private async recordTransaction(
    manager: EntityManager,
    params: RecordTransactionParams,
  ): Promise<void> {
    await manager.save(
      manager.create(WalletTransaction, {
        userId: params.userId,
        idempotencyKey: params.idempotencyKey,
        type: params.type,
        amount: params.amount.toString(),
        balanceAfter: params.balanceAfter.toString(),
        referenceId: params.referenceId ?? null,
      }),
    );
  }

  async getBalance(userId: string): Promise<bigint> {
    const wallet = await this.getOrCreateWallet(
      this.walletRepository.manager,
      userId,
    );
    return BigInt(wallet.cachedBalance);
  }

  async placeBet(
    userId: string,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<{ balance: bigint }> {
    const lock = await this.redisLock.acquire(userId);
    if (!lock.acquired) {
      throw new ConflictException('Wallet is busy, retry shortly');
    }

    try {
      return await this.walletRepository.manager.transaction(
        async (manager) => {
          // idempotent replay — same key already processed, return its result
          // instead of debiting again
          const existingTx = await manager.findOneBy(WalletTransaction, {
            userId,
            idempotencyKey,
          });
          if (existingTx) {
            return { balance: BigInt(existingTx.balanceAfter) };
          }

          const wallet = await this.getOrCreateWallet(manager, userId);
          const current = BigInt(wallet.cachedBalance);

          if (current < amount) {
            throw new BadRequestException('Insufficient balance');
          }

          // simulates a DB round-trip — this is the gap where the race
          // condition used to happen before the Redis lock was added
          await new Promise((resolve) => setTimeout(resolve, 10));

          const next = current - amount;

          await this.updateBalanceWithVersionCheck(
            manager,
            userId,
            next,
            wallet.version,
          );

          await this.recordTransaction(manager, {
            userId,
            idempotencyKey,
            type: WalletTransactionType.BET,
            amount: -amount,
            balanceAfter: next,
            referenceId: null,
          });

          return { balance: next };
        },
      );
    } finally {
      await lock.release();
    }
  }
}
