import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisLockService } from './redis-lock.service';
import { Wallet } from './wallet.entity';

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
  private async getOrCreateWallet(userId: string): Promise<Wallet> {
    const existing = await this.walletRepository.findOneBy({ userId });
    if (existing) {
      return existing;
    }

    const wallet = this.walletRepository.create({
      userId,
      cachedBalance: '1000',
    });
    return this.walletRepository.save(wallet);
  }

  async getBalance(userId: string): Promise<bigint> {
    const wallet = await this.getOrCreateWallet(userId);
    return BigInt(wallet.cachedBalance);
  }

  async placeBet(userId: string, amount: bigint): Promise<{ balance: bigint }> {
    const lock = await this.redisLock.acquire(userId);
    if (!lock.acquired) {
      throw new ConflictException('Wallet is busy, retry shortly');
    }

    try {
      const wallet = await this.getOrCreateWallet(userId);
      const current = BigInt(wallet.cachedBalance);

      if (current < amount) {
        throw new BadRequestException('Insufficient balance');
      }

      // simulates a DB round-trip — this is the gap where the race condition
      // used to happen before the Redis lock was added
      await new Promise((resolve) => setTimeout(resolve, 10));

      const next = current - amount;

      const result = await this.walletRepository
        .createQueryBuilder()
        .update(Wallet)
        .set({ cachedBalance: next.toString(), version: () => '"version" + 1' })
        .where('userId = :userId AND version = :version', {
          userId,
          version: wallet.version,
        })
        .execute();

      if (result.affected === 0) {
        throw new ConflictException('Concurrent modification detected, retry');
      }

      return { balance: next };
    } finally {
      await lock.release();
    }
  }
}
