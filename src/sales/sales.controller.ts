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
import { CreateFreeSaleDto } from './dto/create-free-sale.dto';
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
    const userRole = claims?.['custom:role'] || claims?.role || 'User';
    if (userRole !== 'Reseller') {
      throw new HttpException(
        'No autorizado: Requiere rol Reseller',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private ensureAdmin(claims: any) {
    const userRole = claims?.['custom:role'] || claims?.role || 'User';
    if (userRole !== 'Admin') {
      throw new HttpException(
        'No autorizado: Requiere rol Admin',
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
        undefined,
        undefined,
        claims['custom:role'] || 'User', // Pasar el rol del JWT
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
        claims['custom:role'] || 'User', // Pasar el rol del JWT
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

  @Post('admin/free')
  @UsePipes(new ValidationPipe({ transform: true }))
  async createFreeTicket(@Body() dto: CreateFreeSaleDto, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      
      try {
        this.ensureAdmin(claims);
      } catch (authError: unknown) {
        const errorMessage = authError instanceof Error ? authError.message : 'Error desconocido';
        console.error('Error de autorización:', errorMessage);
        return {
          statusCode: HttpStatus.FORBIDDEN,
          message: errorMessage || 'No autorizado: Requiere rol Admin',
          error: 'FORBIDDEN',
        };
      }
      
      try {
        const sale = await this.salesService.createFreeSale(
          dto,
          claims['sub'],
          claims['email'] || claims['cognito:username'],
        );
        
        return {
          statusCode: HttpStatus.OK,
          message: 'Ticket gratis generado exitosamente',
          data: sale,
        };
      } catch (serviceError: any) {
        console.error('Error en createFreeSale:', {
          message: serviceError.message,
          stack: serviceError.stack,
        });
        return {
          statusCode: serviceError.statusCode || serviceError.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: serviceError.message || 'Error al generar ticket gratis',
          error: serviceError.name || 'SERVICE_ERROR',
        };
      }
    } catch (error: any) {
      console.error('Error inesperado en createFreeTicket:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
      });
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Error inesperado al procesar solicitud de ticket gratis',
        error: error?.message || 'UNKNOWN_ERROR',
      };
    }
  }

  @Post('webhook')
  async handleWebhook(@Body() body: any) {
    try {
      if (body.action === 'payment.updated') {
        const paymentId = body.data.id;
        await this.salesService.handleWebhook(paymentId);
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
