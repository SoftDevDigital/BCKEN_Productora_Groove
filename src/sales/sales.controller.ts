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
import { CreateSaleDto } from './dto/create-sale.dto';
import type { Request } from 'express';

@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

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
      const sale = await this.salesService.createSale(dto, claims['sub']);
      return {
        statusCode: HttpStatus.OK,
        message: 'Venta registrada como pendiente. Complete el pago.',
        data: sale,
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
        claims['sub'],
      );
      return {
        statusCode: HttpStatus.OK,
        message:
          'Venta por revendedor registrada como pendiente. Complete el pago.',
        data: sale,
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
}
