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

  @Post()
  @UsePipes(new ValidationPipe({ transform: true }))
  async create(@Body() dto: CreateSaleDto, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAuthenticated(claims);
      return await this.salesService.createSale(dto, claims['sub']);
    } catch (error) {
      throw new HttpException(
        'Error al procesar la compra',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
