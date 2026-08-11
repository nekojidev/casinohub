import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum WalletTransactionType {
  BET = 'BET',
  PAYOUT = 'PAYOUT',
  BONUS = 'BONUS',
  DEPOSIT = 'DEPOSIT',
}

@Entity('wallet_transactions')
@Unique(['userId', 'idempotencyKey'])
@Index(['userId', 'createdAt'])
export class WalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  userId!: string;

  @Column({ length: 128 })
  idempotencyKey!: string;

  @Column({ type: 'enum', enum: WalletTransactionType })
  type!: WalletTransactionType;

  // signed: negative for BET, positive for PAYOUT/BONUS/DEPOSIT
  @Column('bigint')
  amount!: string;

  @Column('bigint')
  balanceAfter!: string;

  @Column({ type: 'uuid', nullable: true })
  referenceId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
