import { Body, Controller, Post } from '@nestjs/common';
import { RngService } from './rng.service';

interface RollDto {
  outcomeSpace: number;
}

@Controller('rng')
export class RngController {
  constructor(private readonly rngService: RngService) {}

  @Post('roll')
  roll(@Body() dto: RollDto) {
    return { result: this.rngService.roll(dto.outcomeSpace) };
  }
}
