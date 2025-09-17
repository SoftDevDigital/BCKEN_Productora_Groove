import {
  Controller,
  Post,
  Body,
  UsePipes,
  ValidationPipe,
  HttpException,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { SalesService } from './sales.service';
import { PaymentsService } from '../payments/payments.service';
import { BatchesService } from '../batches/batches.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import type { Request } from 'express';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly paymentsService: PaymentsService,
    private readonly batchesService: BatchesService,
  ) {}

  private getClaims(req: Request): any {
    let claims: any = null;
    if (req['apiGateway']) {
      const ctx = req['apiGateway'].event.requestContext;
      claims = ctx.authorizer?.jwt?.claims || ctx.authorizer?.claims || null;
    }
    if (!claims) {
      const token = req.headers['authorization']?.replace('Bearer ', '');
      if (token) {
        claims = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString(),
        );
      }
    }
    return claims;
  }

  private ensureAuthenticated(claims: any) {
    if (!claims || !claims['sub']) {
      throw new HttpException('No autorizado', HttpStatus.UNAUTHORIZED);
    }
  }

  private ensureReseller(claims: any) {
    const userRole = claims?.['custom:role'] || 'User';
    if (userRole !== 'Reseller') {
      throw new HttpException(
        'No autorizado: Requiere rol Reseller',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  @Post()
  @UsePipes(new ValidationPipe({ transform: true }))
  async createDirect(@Body() dto: CreateSaleDto, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAuthenticated(claims);
      if (dto.type !== 'direct') {
        throw new HttpException(
          'Use /sales/reseller para ventas por revendedor',
          HttpStatus.BAD_REQUEST,
        );
      }
      const sale = await this.salesService.createSale(
        dto,
        claims['sub'],
        claims['email'],
      );
      const batch = await this.batchesService.findOne(dto.eventId, dto.batchId);
      const qr = await this.paymentsService.generateQr(
        {
          title: `Compra de ${dto.quantity} ticket(s) para evento ${dto.eventId}`,
          amount: sale.total,
          saleId: sale.id,
        },
        sale.id,
      );
      return {
        statusCode: HttpStatus.OK,
        message: 'Venta registrada como pendiente. Complete el pago.',
        data: { ...sale, paymentLink: qr.paymentLink },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al procesar la compra',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('reseller')
  @UsePipes(new ValidationPipe({ transform: true }))
  async createReseller(@Body() dto: CreateSaleDto, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureReseller(claims);
      if (dto.type !== 'reseller') {
        throw new HttpException(
          'Use /sales para ventas directas',
          HttpStatus.BAD_REQUEST,
        );
      }
      const sale = await this.salesService.createSale(
        dto,
        claims['sub'],
        claims['email'],
        claims['sub'],
        claims['email'],
      );
      const batch = await this.batchesService.findOne(dto.eventId, dto.batchId);
      const qr = await this.paymentsService.generateQr(
        {
          title: `Compra de ${dto.quantity} ticket(s) para evento ${dto.eventId} (Revendedor)`,
          amount: sale.total,
          saleId: sale.id,
        },
        sale.id,
      );
      return {
        statusCode: HttpStatus.OK,
        message:
          'Venta por revendedor registrada como pendiente. Complete el pago.',
        data: { ...sale, paymentLink: qr.paymentLink },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al procesar la compra por revendedor',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('webhook')
  async handleWebhook(@Body() body: any) {
    console.log("entro a webhook con body:", body); // Log para debug
    try {
      if (body.action === 'payment.updated') {
        console.log("entro al if de webhook")
        const paymentId = body.data.id;
          console.log("paymentId extraido:", paymentId); // Log para debug
        await this.salesService.handleWebhook(paymentId);
        console.log("webhook procesado correctamente para paymentId:", paymentId); // Log para debug
      }
      return {
        statusCode: HttpStatus.OK,
        message: 'Notificación recibida',
      };
    } catch (error) {
      console.error('Error en webhook:', error);
      throw new HttpException(
        'Error al procesar webhook',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
