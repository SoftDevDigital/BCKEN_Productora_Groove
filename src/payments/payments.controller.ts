import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreateQrDto } from './dto/create-qr.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('generate-qr')
  @UsePipes(new ValidationPipe({ transform: true }))
  async generateQr(@Body() createQrDto: CreateQrDto) {
    return this.paymentsService.generateQr(createQrDto, createQrDto.saleId);
  }

  @Get('success')
  async handleSuccess(@Query('saleId') saleId: string) {
    return {
      statusCode: 200,
      message: 'Pago exitoso. Procesando confirmación.',
      saleId,
    };
  }

  @Get('failure')
  async handleFailure(@Query('saleId') saleId: string) {
    return {
      statusCode: 400,
      message: 'Pago fallido. Intente nuevamente.',
      saleId,
    };
  }

  @Get('pending')
  async handlePending(@Query('saleId') saleId: string) {
    return {
      statusCode: 200,
      message: 'Pago pendiente. Esperando confirmación.',
      saleId,
    };
  }
}
