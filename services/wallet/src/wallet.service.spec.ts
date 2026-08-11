import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { RedisLockService } from './redis-lock.service';
import { Wallet } from './wallet.entity';
import { WalletService } from './wallet.service';

describe('WalletService concurrency', () => {
  it('does not double-spend under parallel bets', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: 'localhost',
          port: 5432,
          username: 'casino_dev',
          password: 'dev_password',
          database: 'casino_wallet_dev',
          entities: [Wallet],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([Wallet]),
      ],
      providers: [WalletService, RedisLockService],
    }).compile();
    const walletService = moduleRef.get(WalletService);

    const userId = randomUUID(); // fresh wallet per run, starting balance is 1000n
    const betAmount = 100n;

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        walletService.placeBet(userId, betAmount),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const finalBalance = await walletService.getBalance(userId);

    expect(succeeded.length).toBe(10);
    expect(finalBalance).toBe(0n);

    await moduleRef.close();
  });
});
