import {
  Controller,
  Get,
  Param,
  Req,
  HttpException,
  HttpStatus,
  Post,
  Body,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import type { Request } from 'express';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

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

  private ensureAdmin(claims: any) {
    const userRole = claims?.['custom:role'] || 'User';
    if (userRole !== 'Admin') {
      throw new HttpException(
        'No autorizado: Requiere rol Admin',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  @Get('validate/:ticketId')
  async validateTicket(
    @Param('ticketId') ticketId: string,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const ticket = await this.ticketsService.validateTicket(ticketId);
      return {
        statusCode: HttpStatus.OK,
        message: 'Ticket válido',
        data: ticket,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al validar ticket',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':ticketId/qr')
  async getTicketQr(
    @Param('ticketId') ticketId: string,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const ticket = await this.ticketsService.validateTicket(ticketId);
      return {
        statusCode: HttpStatus.OK,
        message: 'QR del ticket obtenido',
        data: { qrS3Url: ticket.qrS3Url },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al obtener QR del ticket',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('admin/scan')
  async scanTicket(
    @Body() body: { ticketId: string },
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const ticket = await this.ticketsService.validateTicket(body.ticketId);
      return {
        statusCode: HttpStatus.OK,
        message: 'Ticket escaneado y válido',
        data: {
          ticketId: ticket.id,
          saleId: ticket.saleId,
          userId: ticket.userId,
          eventId: ticket.eventId,
          batchId: ticket.batchId,
          status: ticket.status,
          qrS3Url: ticket.qrS3Url,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al escanear ticket',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}