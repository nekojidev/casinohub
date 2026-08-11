import {
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity('wallets')
export class Wallet {
  @PrimaryColumn('uuid')
  userId!: string;

  @Column({ type: 'bigint', default: 0 })
  cachedBalance!: string;

  @VersionColumn()
  version!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}
