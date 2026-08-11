import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisLockModule } from '../redis/redis-lock.module';
import { WalletController } from './wallet.controller';
import { WalletTransaction } from './wallet-transaction.entity';
import { Wallet } from './wallet.entity';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Wallet, WalletTransaction]),
    RedisLockModule,
  ],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
