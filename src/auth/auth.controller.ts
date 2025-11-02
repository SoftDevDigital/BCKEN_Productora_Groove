import {
  Controller,
  Post,
  Delete,
  Body,
  UsePipes,
  ValidationPipe,
  HttpStatus,
  HttpException,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { CognitoService } from './cognito/cognito.service';
import { SignUpDto } from './dto/signup.dto';
import { SignInDto } from './dto/signin.dto';
import { ConfirmDto } from './dto/confirm.dto';
import { ResendDto } from './dto/resend.dto';
import { AdminConfirmDto } from './dto/admin-confirm.dto';
import type { Request } from 'express';
import * as jwt from 'jsonwebtoken';

@Controller('auth')
export class AuthController {
  constructor(private cognitoService: CognitoService) {}

  private getClaims(req: Request): any {
    let claims: any = null;
    if (req['apiGateway']) {
      const ctx = req['apiGateway'].event.requestContext;
      claims = ctx.authorizer?.jwt?.claims || ctx.authorizer?.claims || null;
    }
    if (!claims) {
      const token = req.headers['authorization']?.replace('Bearer ', '');
      if (token) {
        claims = jwt.decode(token) as any;
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

  @Post('signup')
  @UsePipes(new ValidationPipe({ transform: true }))
  async signUp(@Body() dto: SignUpDto) {
    try {
      const result = await this.cognitoService.signUp(
        dto.name,
        dto.last_name,
        dto.email,
        dto.password,
      );
      return {
        statusCode: HttpStatus.CREATED,
        message:
          'Usuario registrado exitosamente. Verifica tu email para confirmar.',
        userSub: result.UserSub,
        codeDeliveryDetails: result.CodeDeliveryDetails,
      };
    } catch (error) {
      if (error.name === 'UsernameExistsException') {
        throw new HttpException(
          'El email ya está registrado. Intenta con signin.',
          HttpStatus.CONFLICT,
        );
      }
      if (
        error.name === 'InvalidParameterException' ||
        error.name === 'InvalidUserAttributeException'
      ) {
        throw new HttpException(
          'Parámetros inválidos en el registro. Verifica el formato del email, password o rol.',
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        'Error al registrar usuario',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('signin')
  @UsePipes(new ValidationPipe({ transform: true }))
  async signIn(@Body() dto: SignInDto) {
    try {
      const result = await this.cognitoService.signIn(dto.email, dto.password);
      if (result.$metadata.httpStatusCode !== 200) {
        throw result;
      }
      const { AuthenticationResult } = result;
      if (!AuthenticationResult) {
        throw new HttpException(
          'Error en la autenticación: No se recibieron tokens',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const { IdToken, AccessToken, RefreshToken, ExpiresIn } =
        AuthenticationResult;
      if (!IdToken) {
        throw new HttpException(
          'Error en la autenticación: IdToken no definido',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const payload: {
        sub: string;
        email: string;
        given_name: string;
        family_name: string;
        [key: string]: any;
      } = JSON.parse(Buffer.from(IdToken.split('.')[1], 'base64').toString());
      return {
        statusCode: HttpStatus.OK,
        message: 'Login exitoso',
        accessToken: AccessToken,
        idToken: IdToken,
        refreshToken: RefreshToken,
        expiresIn: ExpiresIn,
        user: {
          sub: payload.sub,
          email: payload.email,
          given_name: payload['given_name'],
          family_name: payload['family_name'],
          'custom:role': payload['custom:role'] || 'User',
          'custom:country': payload['custom:country'],
        },
      };
    } catch (error) {
      if (error.name === 'NotAuthorizedException') {
        throw new HttpException(
          'Email o contraseña incorrectos',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (error.name === 'UserNotConfirmedException') {
        throw new HttpException(
          'Usuario no confirmado. Verifica tu email primero.',
          HttpStatus.FORBIDDEN,
        );
      }
      throw new HttpException('Error en el login', HttpStatus.UNAUTHORIZED);
    }
  }

  @Post('admin/assign-role')
  @UsePipes(new ValidationPipe({ transform: true }))
  async assignRole(
    @Req() req: Request,
    @Body() body: { userSub: string; role: string },
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      await this.cognitoService.adminAssignRole(body.userSub, body.role);
      return {
        statusCode: HttpStatus.OK,
        message: `Rol "${body.role}" asignado exitosamente al usuario ${body.userSub}`,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
      }
      throw new HttpException(
        'Error al asignar rol',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('admin/sync-roles')
  @UsePipes(new ValidationPipe({ transform: true }))
  async syncRoles(@Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const result = await this.cognitoService.syncAllUserRoles();
      return {
        statusCode: HttpStatus.OK,
        message: 'Roles sincronizados exitosamente',
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        'Error al sincronizar roles',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('admin/delete-user')
  @UsePipes(new ValidationPipe({ transform: true }))
  async deleteUser(
    @Req() req: Request,
    @Body() body: { userSub: string },
  ) {
    console.log('=== DELETE USER AUTH CONTROLLER ===');
    console.log('Received body:', body);
    console.log('Received userSub:', body.userSub);
    try {
      const claims = this.getClaims(req);
      console.log('User claims:', {
        sub: claims?.sub,
        role: claims?.['custom:role'],
        email: claims?.email,
      });
      this.ensureAdmin(claims);
      console.log('Admin authorization passed');
      
      console.log('Calling cognitoService.adminDeleteUser with userSub:', body.userSub);
      const result = await this.cognitoService.adminDeleteUser(body.userSub);
      console.log('Service returned result:', result);
      
      return {
        statusCode: HttpStatus.OK,
        message: `Usuario ${body.userSub} eliminado exitosamente de Cognito y DynamoDB`,
        data: result,
      };
    } catch (error) {
      console.error('DELETE USER ERROR in auth controller:', error);
      if (error instanceof BadRequestException) {
        throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
      }
      throw new HttpException(
        'Error al eliminar usuario',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('admin/confirm-signup')
  @UsePipes(new ValidationPipe({ transform: true }))
  async adminConfirm(@Req() req: Request, @Body() dto: AdminConfirmDto) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      await this.cognitoService.adminConfirmSignUp(dto.username);
      return {
        statusCode: HttpStatus.OK,
        message: 'Usuario confirmado manualmente',
      };
    } catch (error) {
      throw new HttpException(
        'Error al confirmar usuario manualmente',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('confirm')
  @UsePipes(new ValidationPipe({ transform: true }))
  async confirm(@Body() dto: ConfirmDto) {
    try {
      await this.cognitoService.confirmSignUp(dto.username, dto.code);
      return {
        statusCode: HttpStatus.OK,
        message: 'Email confirmado exitosamente. Ahora puedes iniciar sesión.',
      };
    } catch (error) {
      if (error.name === 'CodeMismatchException') {
        throw new HttpException(
          'Código de verificación incorrecto',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (error.name === 'ExpiredCodeException') {
        throw new HttpException(
          'Código expirado. Solicita uno nuevo.',
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        'Error al confirmar email',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('resend-confirmation')
  @UsePipes(new ValidationPipe({ transform: true }))
  async resend(@Body() dto: ResendDto) {
    try {
      const result = await this.cognitoService.resendConfirmation(dto.email);
      return {
        statusCode: HttpStatus.OK,
        message: 'Código reenviado exitosamente. Revisa tu email.',
        codeDeliveryDetails: result.CodeDeliveryDetails,
      };
    } catch (error) {
      if (error.message === 'Debes esperar 1 minuto desde el último reenvío.') {
        throw new HttpException(error.message, HttpStatus.TOO_MANY_REQUESTS);
      }
      if (error.name === 'UserNotFoundException') {
        throw new HttpException(
          'Usuario no encontrado. Regístrate primero.',
          HttpStatus.NOT_FOUND,
        );
      }
      throw new HttpException(
        'Error al reenviar código',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
