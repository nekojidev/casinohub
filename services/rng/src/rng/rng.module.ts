import { Module } from '@nestjs/common';
import { RngController } from './rng.controller';
import { RngService } from './rng.service';

@Module({
  controllers: [RngController],
  providers: [RngService],
})
export class RngModule {}
