import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('fair_rounds')
export class FairRound {
  @PrimaryGeneratedColumn('uuid')
  roundId!: string;

  @Column('uuid')
  userId!: string;

  // published to the client BEFORE the bet — this is the commitment
  @Column({ length: 64 })
  serverSeedHash!: string;

  // never sent to the client until revealSeed() runs — nullable until then
  @Column({ type: 'varchar', length: 64, nullable: true })
  serverSeed!: string | null;

  @Column({ length: 64 })
  clientSeed!: string;

  @Column('int')
  nonce!: number;

  @Column({ type: 'int', nullable: true })
  outcome!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  revealedAt!: Date | null;
}
