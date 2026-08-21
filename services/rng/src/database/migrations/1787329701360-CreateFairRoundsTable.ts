import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateFairRoundsTable1787329701360 implements MigrationInterface {
    name = 'CreateFairRoundsTable1787329701360'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "fair_rounds" ("roundId" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "serverSeedHash" character varying(64) NOT NULL, "serverSeed" character varying(64), "clientSeed" character varying(64) NOT NULL, "nonce" integer NOT NULL, "outcome" integer, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "revealedAt" TIMESTAMP, CONSTRAINT "PK_499164ee657751d261dabc1324a" PRIMARY KEY ("roundId"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "fair_rounds"`);
    }

}
