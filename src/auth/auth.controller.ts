import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
  UsePipes,
  ValidationPipe,
  Req,
} from '@nestjs/common';
import { CognitoService } from './cognito/cognito.service';
import { SignUpDto } from './dto/signup.dto';
import { SignInDto } from './dto/signin.dto';
import { ConfirmDto } from './dto/confirm.dto';
import { ResendDto } from './dto/resend.dto';
import type { Request } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly cognitoService: CognitoService) {}

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

  @Post('signup')
  @UsePipes(new ValidationPipe({ transform: true }))
  async signUp(@Body() signUpDto: SignUpDto) {
    try {
      const { name, last_name, email, password } = signUpDto;
      const result = await this.cognitoService.signUp(
        name,
        last_name,
        email,
        password,
      );
      return {
        statusCode: HttpStatus.CREATED,
        message:
          'Usuario registrado exitosamente. Verifica tu email para confirmar.',
        userSub: result.userSub,
        codeDeliveryDetails: result.codeDeliveryDetails,
      };
    } catch (error) {
      throw error; // Excepciones manejadas por CognitoService
    }
  }

  @Post('signin')
  @UsePipes(new ValidationPipe({ transform: true }))
  async signIn(@Body() signInDto: SignInDto) {
    try {
      const { email, password } = signInDto;
      const result = await this.cognitoService.signIn(email, password);
      return {
        statusCode: HttpStatus.OK,
        message: 'Login exitoso',
        accessToken: result.accessToken,
        idToken: result.idToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      };
    } catch (error) {
      throw error; // Excepciones manejadas por CognitoService
    }
  }

  @Post('confirm')
  @UsePipes(new ValidationPipe({ transform: true }))
  async confirm(@Body() confirmDto: ConfirmDto) {
    try {
      const { username, code } = confirmDto;
      await this.cognitoService.confirmSignUp(username, code);
      return {
        statusCode: HttpStatus.OK,
        message: 'Email confirmado exitosamente. Ahora puedes iniciar sesión.',
      };
    } catch (error) {
      throw error; // Excepciones manejadas por CognitoService
    }
  }

  @Post('resend-confirmation')
  @UsePipes(new ValidationPipe({ transform: true }))
  async resendConfirmation(@Body() resendDto: ResendDto) {
    try {
      const { email } = resendDto;
      const result = await this.cognitoService.resendConfirmation(email);
      return {
        statusCode: HttpStatus.OK,
        message: 'Código reenviado exitosamente. Revisa tu email.',
        codeDeliveryDetails: result.codeDeliveryDetails,
      };
    } catch (error) {
      throw error; // Excepciones manejadas por CognitoService
    }
  }

  @Post('admin/assign-role')
  @UsePipes(new ValidationPipe({ transform: true }))
  async assignRole(
    @Body('userSub') userSub: string,
    @Body('role') role: string,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      await this.cognitoService.adminAssignRole(userSub, role);
      return {
        statusCode: HttpStatus.OK,
        message: `Rol "${role}" asignado exitosamente al usuario ${userSub}`,
      };
    } catch (error) {
      throw error; // Excepciones manejadas por CognitoService
    }
  }

  @Post('admin/confirm-signup')
  @UsePipes(new ValidationPipe({ transform: true }))
  async adminConfirmSignUp(
    @Body('username') username: string,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      await this.cognitoService.adminConfirmSignUp(username);
      return {
        statusCode: HttpStatus.OK,
        message: 'Usuario confirmado manualmente',
      };
    } catch (error) {
      throw error; // Excepciones manejadas por CognitoService
    }
  }
}
