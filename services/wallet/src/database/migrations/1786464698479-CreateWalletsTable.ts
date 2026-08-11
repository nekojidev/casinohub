import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateWalletsTable1786464698479 implements MigrationInterface {
    name = 'CreateWalletsTable1786464698479'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "wallets" ("userId" uuid NOT NULL, "cachedBalance" bigint NOT NULL DEFAULT '0', "version" integer NOT NULL, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2ecdb33f23e9a6fc392025c0b97" PRIMARY KEY ("userId"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "wallets"`);
    }

}
