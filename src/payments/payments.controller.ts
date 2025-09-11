import { Controller, Post, Body } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreateQrDto } from './dto/create-qr.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('generate-qr')
  async generateQr(@Body() createQrDto: CreateQrDto) {
    return this.paymentsService.generateQr(createQrDto);
  }
}
