import { Module } from '@nestjs/common';
import { RngModule } from './rng/rng.module';

@Module({
  imports: [RngModule],
})
export class AppModule {}
