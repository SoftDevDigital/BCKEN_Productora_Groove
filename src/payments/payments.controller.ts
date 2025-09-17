import {
  Controller,
  Get,
  Query,
  HttpException,
  HttpStatus,
  Res,
  NotFoundException,
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
  private validateId(id: string, fieldName: string = 'ID'): void {
    if (!id || id.trim() === '') {
      throw new HttpException(`El ${fieldName} no puede estar vacío`, HttpStatus.BAD_REQUEST);
    }
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(id)) {
      throw new HttpException(`El ${fieldName} no tiene un formato válido (debe ser un UUID)`, HttpStatus.BAD_REQUEST);
    }
  }
  @Get('success')
  async handleSuccess(
    @Query('saleId') saleId: string,
    @Query('collection_id') paymentId: string,
    @Res() res: Response,
  ) {
    console.log('handleSuccess llamado:', { saleId, paymentId });
    try {
      this.validateId(saleId, 'saleId');
      this.validateId(paymentId, 'paymentId');
      const payment = await this.paymentsService.getPaymentStatus(paymentId);
      if (payment.external_reference !== saleId) {
        throw new HttpException(
          'Mismatch en saleId con external_reference',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (payment.status !== 'approved' && payment.status !== 'pending') {
        throw new HttpException(
          `Estado de pago inválido: ${payment.status}. Use la ruta /failure para pagos rechazados`,
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.salesService.confirmSale(saleId, payment.status, paymentId);
      const frontendUrl = this.configService.get<string>('FRONTEND_BASE_URL') || 'https://fest-go.com';
      const redirectPath = payment.status === 'approved' ? 'success' : 'pending';
      console.log('Redirigiendo a:', `${frontendUrl}/${redirectPath}?saleId=${saleId}`);
      res.redirect(302, `${frontendUrl}/${redirectPath}?saleId=${saleId}`);
    } catch (error) {
      console.error('Error en handleSuccess:', error);
      const frontendUrl = this.configService.get<string>('FRONTEND_BASE_URL') || 'https://fest-go.com';
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      console.log('Redirigiendo por error a:', `${frontendUrl}?error=${encodeURIComponent(errorMessage)}`);
      res.redirect(302, `${frontendUrl}?error=${encodeURIComponent(errorMessage)}`);
    }
  }
  @Get('failure')
  async handleFailure(
    @Query('saleId') saleId: string,
    @Query('collection_id') paymentId: string,
    @Res() res: Response,
  ) {
    console.log('handleFailure llamado:', { saleId, paymentId });
    try {
      this.validateId(saleId, 'saleId');
      this.validateId(paymentId, 'paymentId');
      const payment = await this.paymentsService.getPaymentStatus(paymentId);
      if (payment.status !== 'rejected') {
        throw new HttpException(
          `Estado de pago inválido: ${payment.status}. Use la ruta /success para pagos aprobados o pendientes`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (payment.external_reference !== saleId) {
        throw new HttpException(
          'Mismatch en saleId con external_reference',
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.salesService.confirmSale(saleId, 'rejected', paymentId);
      const frontendUrl = this.configService.get<string>('FRONTEND_BASE_URL') || 'https://fest-go.com';
      console.log('Redirigiendo a:', `${frontendUrl}/failure?saleId=${saleId}`);
      res.redirect(302, `${frontendUrl}/failure?saleId=${saleId}`);
    } catch (error) {
      console.error('Error en handleFailure:', error);
      const frontendUrl = this.configService.get<string>('FRONTEND_BASE_URL') || 'https://fest-go.com';
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      console.log('Redirigiendo por error a:', `${frontendUrl}?error=${encodeURIComponent(errorMessage)}`);
      res.redirect(302, `${frontendUrl}?error=${encodeURIComponent(errorMessage)}`);
    }
  }
}