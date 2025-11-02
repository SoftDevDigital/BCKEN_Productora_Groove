import {
  Controller,
  Get,
  Delete,
  Param,
  Req,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { UsersService } from './users.service';
import type { Request } from 'express';
interface User {
  id: string;
  email: string;
  role: string;
  purchasedTickets: string[];
  soldTickets?: string[];
  createdAt: string;
  given_name: string;
  family_name: string;
}
@Controller('user')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}
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
  private ensureAdmin(claims: any) {
    const userRole = claims?.['custom:role'] || 'User';
    if (userRole !== 'Admin') {
      throw new HttpException(
        'No autorizado: Requiere rol Admin',
        HttpStatus.FORBIDDEN,
      );
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
  @Get('profile')
  async getProfile(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAuthenticated(claims);
      const profile = await this.usersService.getUserProfile(claims['sub']);
      return {
        statusCode: HttpStatus.OK,
        message: 'Perfil obtenido exitosamente',
        data: profile,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al obtener perfil',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  @Get('purchases')
  async getPurchases(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAuthenticated(claims);
      const purchases = await this.usersService.getUserPurchases(claims['sub']);
      return {
        statusCode: HttpStatus.OK,
        message: 'Compras obtenidas exitosamente',
        data: purchases,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al obtener compras',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  @Get('sales')
  async getSales(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureReseller(claims);
      const sales = await this.usersService.getUserSales(claims['sub']);
      return {
        statusCode: HttpStatus.OK,
        message: 'Ventas obtenidas exitosamente',
        data: sales,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al obtener ventas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  @Get('admin/users')
  async getAllUsers(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const users = await this.usersService.getAllUsers();
      return {
        statusCode: HttpStatus.OK,
        message: 'Usuarios obtenidos exitosamente',
        data: users.map((user: User) => ({
          id: user.id,
          email: user.email,
          given_name: user.given_name,
          family_name: user.family_name,
          role: user.role,
          purchasedTickets: user.purchasedTickets,
          // Solo mostrar soldTickets para usuarios con rol Reseller
          ...(user.role === 'Reseller' && { soldTickets: user.soldTickets }),
          createdAt: user.createdAt,
        })),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al listar usuarios',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('admin/users/:userId')
  async deleteUser(@Param('userId') userId: string, @Req() req: Request) {
    console.log('=== DELETE USER CONTROLLER ===');
    console.log('Received userId:', userId);
    try {
      const claims = this.getClaims(req);
      console.log('User claims:', {
        sub: claims?.sub,
        role: claims?.['custom:role'],
        email: claims?.email,
      });
      
      // Validar admin pero no lanzar error crítico
      try {
        this.ensureAdmin(claims);
        console.log('Admin authorization passed');
      } catch (authError: any) {
        console.error('Authorization failed:', authError.message);
        return {
          statusCode: HttpStatus.FORBIDDEN,
          message: authError.message || 'No autorizado: Requiere rol Admin',
          error: 'FORBIDDEN',
        };
      }
      
      console.log('Calling usersService.deleteUser with userId:', userId);
      
      try {
        const result = await this.usersService.deleteUser(userId);
        console.log('Service returned result:', result);
        
        return {
          statusCode: HttpStatus.OK,
          message: result.message,
        };
      } catch (serviceError: any) {
        console.error('Service error (non-critical):', serviceError.message);
        // Retornar respuesta pero no lanzar excepción
        return {
          statusCode: serviceError.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: serviceError.message || 'Error al eliminar usuario',
          error: serviceError.name || 'SERVICE_ERROR',
        };
      }
    } catch (error: any) {
      console.error('DELETE USER ERROR in controller (unexpected):', error);
      // Siempre retornar respuesta HTTP, nunca lanzar excepción no controlada
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Error inesperado al procesar eliminación de usuario',
        error: error?.message || 'UNKNOWN_ERROR',
      };
    }
  }
}
