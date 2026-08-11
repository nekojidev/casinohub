import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWalletTransactionsTable1786484580501 implements MigrationInterface {
  name = 'CreateWalletTransactionsTable1786484580501';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."wallet_transactions_type_enum" AS ENUM('BET', 'PAYOUT', 'BONUS', 'DEPOSIT')`,
    );
    await queryRunner.query(
      `CREATE TABLE "wallet_transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "idempotencyKey" character varying(128) NOT NULL, "type" "public"."wallet_transactions_type_enum" NOT NULL, "amount" bigint NOT NULL, "balanceAfter" bigint NOT NULL, "referenceId" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_cddb3be00e344a93ec62290f84d" UNIQUE ("userId", "idempotencyKey"), CONSTRAINT "PK_5120f131bde2cda940ec1a621db" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4760946361d928decab5158603" ON "wallet_transactions"  ("userId", "createdAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4760946361d928decab5158603"`,
    );
    await queryRunner.query(`DROP TABLE "wallet_transactions"`);
    await queryRunner.query(
      `DROP TYPE "public"."wallet_transactions_type_enum"`,
    );
  }
}
