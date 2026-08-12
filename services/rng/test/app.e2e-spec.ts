import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('RngController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('POST /rng/roll returns a result within range', () => {
    return request(app.getHttpServer())
      .post('/rng/roll')
      .send({ outcomeSpace: 37 })
      .expect(201)
      .expect((res) => {
        const body = res.body as { result: number };
        if (!Number.isInteger(body.result)) {
          throw new Error('result is not an integer');
        }
        if (body.result < 0 || body.result >= 37) {
          throw new Error('result is out of range');
        }
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
