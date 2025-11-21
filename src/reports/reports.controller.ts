import {
  Controller,
  Get,
  Param,
  Req,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ReportsService } from './reports.service';
import type { Request } from 'express';
import { User } from '../users/users/types';

@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

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

  @Get('sales')
  async getSalesReport(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const report = await this.reportsService.getSalesReport();
      return {
        statusCode: HttpStatus.OK,
        message: 'Reporte de ventas obtenido exitosamente',
        data: report,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al generar reporte de ventas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('sales/:saleId')
  async getSaleDetails(@Param('saleId') saleId: string, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const details = await this.reportsService.getSaleDetails(saleId);
      return {
        statusCode: HttpStatus.OK,
        message: 'Detalles de venta obtenidos exitosamente',
        data: details,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al obtener detalles de venta',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('users')
  async getUsersReport(
    @Req() req: Request,
  ): Promise<{ statusCode: number; message: string; data: User[] }> {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const users = await this.reportsService.getUsersReport();
      return {
        statusCode: HttpStatus.OK,
        message: 'Reporte de usuarios obtenido exitosamente',
        data: users,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al generar reporte de usuarios',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('resellers')
  async getResellersReport(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const report = await this.reportsService.getResellersReport();
      return {
        statusCode: HttpStatus.OK,
        message: 'Reporte de revendedores obtenido exitosamente',
        data: report,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al generar reporte de revendedores',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('scans/:eventId')
  async getScansCountByEvent(@Param('eventId') eventId: string, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      
      try {
        this.ensureAdmin(claims);
      } catch (authError: any) {
        console.error('Error de autorización:', authError.message);
        return {
          statusCode: HttpStatus.FORBIDDEN,
          message: authError.message || 'No autorizado: Requiere rol Admin',
          error: 'FORBIDDEN',
        };
      }

      try {
        const result = await this.reportsService.getScansCountByEvent(eventId);
        return {
          statusCode: HttpStatus.OK,
          message: 'Conteo de escaneos obtenido exitosamente',
          data: result,
        };
      } catch (serviceError: any) {
        console.error('Error en getScansCountByEvent:', {
          message: serviceError.message,
          stack: serviceError.stack,
        });
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: serviceError.message || 'Error al obtener conteo de escaneos',
          error: serviceError.name || 'SERVICE_ERROR',
          data: { eventId, scansCount: 0 }, // Retornar valor seguro
        };
      }
    } catch (error: any) {
      console.error('Error inesperado en getScansCountByEvent:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
      });
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Error inesperado al obtener conteo de escaneos',
        error: error?.message || 'UNKNOWN_ERROR',
        data: { eventId: eventId || 'unknown', scansCount: 0 }, // Retornar valor seguro
      };
    }
  }

  @Get('scans')
  async getTotalScansCount(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      
      try {
        this.ensureAdmin(claims);
      } catch (authError: any) {
        console.error('Error de autorización:', authError.message);
        return {
          statusCode: HttpStatus.FORBIDDEN,
          message: authError.message || 'No autorizado: Requiere rol Admin',
          error: 'FORBIDDEN',
        };
      }

      try {
        const result = await this.reportsService.getTotalScansCount();
        return {
          statusCode: HttpStatus.OK,
          message: 'Conteo total de escaneos obtenido exitosamente',
          data: result,
        };
      } catch (serviceError: any) {
        console.error('Error en getTotalScansCount:', {
          message: serviceError.message,
          stack: serviceError.stack,
        });
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: serviceError.message || 'Error al obtener conteo total de escaneos',
          error: serviceError.name || 'SERVICE_ERROR',
          data: { totalScans: 0 }, // Retornar valor seguro
        };
      }
    } catch (error: any) {
      console.error('Error inesperado en getTotalScansCount:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
      });
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Error inesperado al obtener conteo total de escaneos',
        error: error?.message || 'UNKNOWN_ERROR',
        data: { totalScans: 0 }, // Retornar valor seguro
      };
    }
  }

  @Get('free-qr')
  async getFreeQRReport(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const report = await this.reportsService.getFreeQRReport();
      return {
        statusCode: HttpStatus.OK,
        message: 'Reporte de QR Free obtenido exitosamente',
        data: report,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al generar reporte de QR Free',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('birthdays')
  async getBirthdayReport(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const report = await this.reportsService.getBirthdayReport();
      return {
        statusCode: HttpStatus.OK,
        message: 'Reporte de cumpleañeros obtenido exitosamente',
        data: report,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al generar reporte de cumpleañeros',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
