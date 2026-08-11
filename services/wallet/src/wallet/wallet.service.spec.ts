import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { RedisLockService } from '../redis/redis-lock.service';
import { WalletTransaction } from './wallet-transaction.entity';
import { Wallet } from './wallet.entity';
import { WalletService } from './wallet.service';

describe('WalletService', () => {
  let moduleRef: TestingModule;
  let walletService: WalletService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: 'localhost',
          port: 5432,
          username: 'casino_dev',
          password: 'dev_password',
          database: 'casino_wallet_dev',
          entities: [Wallet, WalletTransaction],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([Wallet, WalletTransaction]),
      ],
      providers: [WalletService, RedisLockService],
    }).compile();
    walletService = moduleRef.get(WalletService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('does not double-spend under parallel bets', async () => {
    const userId = randomUUID(); // fresh wallet per run, starting balance is 1000n
    const betAmount = 100n;

    // 50 distinct bet attempts — each needs its own idempotency key,
    // otherwise the idempotency check would treat them as one retried request
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        walletService.placeBet(userId, betAmount, randomUUID()),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const finalBalance = await walletService.getBalance(userId);

    expect(succeeded.length).toBe(10);
    expect(finalBalance).toBe(0n);
  });

  it('does not double-spend on a retried request with the same idempotency key', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();

    const first = await walletService.placeBet(userId, 100n, idempotencyKey);
    const second = await walletService.placeBet(userId, 100n, idempotencyKey);

    expect(second.balance).toBe(first.balance);

    const finalBalance = await walletService.getBalance(userId);
    expect(finalBalance).toBe(900n); // debited only once, not twice
  });
});
