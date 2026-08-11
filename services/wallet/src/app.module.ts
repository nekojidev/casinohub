import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisLockService } from './redis-lock.service';
import { Wallet } from './wallet.entity';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'casino_dev',
      password: process.env.DB_PASSWORD ?? 'dev_password',
      database: process.env.DB_NAME ?? 'casino_wallet_dev',
      entities: [Wallet],
      synchronize: false,
    }),
    TypeOrmModule.forFeature([Wallet]),
  ],
  controllers: [WalletController],
  providers: [WalletService, RedisLockService],
})
export class AppModule {}
