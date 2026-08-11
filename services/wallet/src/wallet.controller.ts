import { Body, Controller, Post } from '@nestjs/common';
import { WalletService } from './wallet.service';

interface PlaceBetDto {
  userId: string;
  amount: string;
}

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post('bet')
  async placeBet(@Body() dto: PlaceBetDto) {
    const result = await this.walletService.placeBet(
      dto.userId,
      BigInt(dto.amount),
    );
    return { balance: result.balance.toString() };
  }
}
