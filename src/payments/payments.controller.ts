import {
  Controller,
  Get,
  Query,
  HttpException,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { SalesService } from '../sales/sales.service';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly salesService: SalesService,
    private readonly configService: ConfigService,
  ) {}

  @Get('success')
  async handleSuccess(
    @Query('saleId') saleId: string,
    @Query('collection_id') paymentId: string,
    @Res() res: Response,
  ) {
    console.log('ENTROOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO');
    console.log('handleSuccess called:', { saleId, paymentId }); // Log para debug
    try {
      if (!saleId || !paymentId) {
        throw new HttpException(
          'Faltan parámetros saleId o collection_id',
          HttpStatus.BAD_REQUEST,
        );
      }
      const payment = await this.paymentsService.getPaymentStatus(paymentId);
      if (
        payment.status !== 'approved' ||
        payment.external_reference !== saleId
      ) {
        throw new HttpException(
          'Pago no aprobado o mismatch en saleId',
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.salesService.confirmSale(saleId, 'approved', paymentId);
      const frontendUrl = 'https://fest-go.com/account';
      res.redirect(302, `${frontendUrl}/success?saleId=${saleId}`);
    } catch (error) {
      console.error('Error en handleSuccess:', error); // Log para debug
      const frontendUrl =
        this.configService.get<string>('FRONTEND_BASE_URL') ||
        'https://tu-frontend.com';
      res.redirect(
        302,
        `${frontendUrl}/failure?saleId=${saleId}&error=${encodeURIComponent(error.message)}`,
      );
    }
  }

  @Get('failure')
  async handleFailure(
    @Query('saleId') saleId: string,
    @Query('collection_id') paymentId: string,
    @Res() res: Response,
  ) {
    try {
      if (!saleId || !paymentId) {
        throw new HttpException(
          'Faltan parámetros saleId o collection_id',
          HttpStatus.BAD_REQUEST,
        );
      }
      const payment = await this.paymentsService.getPaymentStatus(paymentId);
      await this.salesService.confirmSale(saleId, 'rejected', paymentId);
      const frontendUrl = this.configService.get<string>('FRONTEND_BASE_URL');
      if (!frontendUrl) {
        throw new HttpException(
          'FRONTEND_BASE_URL is not defined in environment variables',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      res.redirect(302, `${frontendUrl}/failure?saleId=${saleId}`);
    } catch (error) {
      console.error('Error en handleFailure:', error); // Log para debug
      const frontendUrl =
        this.configService.get<string>('FRONTEND_BASE_URL') ||
        'https://tu-frontend.com';
      res.redirect(
        302,
        `${frontendUrl}/failure?saleId=${saleId}&error=${encodeURIComponent(error.message)}`,
      );
    }
  }

  @Get('pending')
  async handlePending(
    @Query('saleId') saleId: string,
    @Query('collection_id') paymentId: string,
    @Res() res: Response,
  ) {
    try {
      if (!saleId || !paymentId) {
        throw new HttpException(
          'Faltan parámetros saleId o collection_id',
          HttpStatus.BAD_REQUEST,
        );
      }
      const payment = await this.paymentsService.getPaymentStatus(paymentId);
      console.log('Payment status:', payment); // Log para debug
      await this.salesService.confirmSale(saleId, 'pending', paymentId);
      const frontendUrl = this.configService.get<string>('FRONTEND_BASE_URL');
      if (!frontendUrl) {
        throw new HttpException(
          'FRONTEND_BASE_URL is not defined in environment variables',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      res.redirect(302, `${frontendUrl}/pending?saleId=${saleId}`);
    } catch (error) {
      console.error('Error en handlePending:', error); // Log para debug
      const frontendUrl =
        this.configService.get<string>('FRONTEND_BASE_URL') ||
        'https://tu-frontend.com';
      res.redirect(
        302,
        `${frontendUrl}/failure?saleId=${saleId}&error=${encodeURIComponent(error.message)}`,
      );
    }
  }
}
