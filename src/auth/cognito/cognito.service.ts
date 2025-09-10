import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
  AdminUpdateUserAttributesCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  AdminConfirmSignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class CognitoService {
  private client: CognitoIdentityProviderClient;
  private lastResend: { [email: string]: number } = {};

  constructor(private configService: ConfigService) {
    this.client = new CognitoIdentityProviderClient({
      region: this.configService.get<string>('AWS_REGION'),
    });
  }

  private getSecretHash(username: string): string {
    const clientId = this.configService.get<string>('COGNITO_CLIENT_ID');
    const clientSecret = this.configService.get<string>(
      'COGNITO_CLIENT_SECRET',
    );
    if (!clientSecret) {
      throw new Error('COGNITO_CLIENT_SECRET is not defined');
    }
    const message = username + clientId;
    return crypto
      .createHmac('sha256', clientSecret)
      .update(message)
      .digest('base64');
  }

  async signUp(
    name: string,
    last_name: string,
    email: string,
    password: string,
  ) {
    try {
      const secretHash = this.getSecretHash(email);
      const command = new SignUpCommand({
        ClientId: this.configService.get<string>('COGNITO_CLIENT_ID'),
        Username: email,
        Password: password,
        SecretHash: secretHash,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'given_name', Value: name },
          { Name: 'family_name', Value: last_name },
          { Name: 'custom:country', Value: 'default' },
          { Name: 'custom:role', Value: 'User' },
        ],
      });
      const result = await this.client.send(command);
      return {
        UserSub: result.UserSub,
        CodeDeliveryDetails: result.CodeDeliveryDetails,
      };
    } catch (error) {
      if (error.name === 'UsernameExistsException') {
        throw error; // Propagado al controller para 409
      }
      if (error.name === 'InvalidParameterException') {
        throw new BadRequestException(
          'Parámetros inválidos: verifica email o password.',
        );
      }
      if (error.name === 'LimitExceededException') {
        throw new BadRequestException(
          'Límite de solicitudes alcanzado. Intenta más tarde.',
        );
      }
      throw new InternalServerErrorException(
        'Error interno al registrar usuario.',
      );
    }
  }

  async signIn(email: string, password: string) {
    try {
      const secretHash = this.getSecretHash(email);
      const command = new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: this.configService.get<string>('COGNITO_CLIENT_ID'),
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
          SECRET_HASH: secretHash,
        },
      });
      return this.client.send(command);
    } catch (error) {
      if (error.name === 'NotAuthorizedException') {
        throw new BadRequestException('Credenciales incorrectas.');
      }
      if (error.name === 'UserNotConfirmedException') {
        throw new BadRequestException(
          'Usuario no confirmado. Verifica tu email.',
        );
      }
      throw new InternalServerErrorException(
        'Error interno al iniciar sesión.',
      );
    }
  }

  async adminAssignRole(userSub: string, role: string) {
    try {
      const command = new AdminUpdateUserAttributesCommand({
        UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
        Username: userSub,
        UserAttributes: [{ Name: 'custom:role', Value: role }],
      });
      return this.client.send(command);
    } catch (error) {
      throw new InternalServerErrorException('Error al asignar rol.');
    }
  }

  async confirmSignUp(email: string, confirmationCode: string) {
    try {
      const secretHash = this.getSecretHash(email);
      const command = new ConfirmSignUpCommand({
        ClientId: this.configService.get<string>('COGNITO_CLIENT_ID'),
        Username: email,
        ConfirmationCode: confirmationCode,
        SecretHash: secretHash,
      });
      return this.client.send(command);
    } catch (error) {
      if (error.name === 'CodeMismatchException') {
        throw new BadRequestException('Código de verificación incorrecto.');
      }
      if (error.name === 'ExpiredCodeException') {
        throw new BadRequestException('Código expirado. Solicita uno nuevo.');
      }
      throw new InternalServerErrorException('Error al confirmar email.');
    }
  }

  async resendConfirmation(email: string) {
    try {
      const now = Date.now();
      const lastResendTime = this.lastResend[email] || 0;
      if (now - lastResendTime < 300000) {
        throw new BadRequestException(
          'Debes esperar 5 minutos desde el último reenvío.',
        );
      }
      const secretHash = this.getSecretHash(email);
      const command = new ResendConfirmationCodeCommand({
        ClientId: this.configService.get<string>('COGNITO_CLIENT_ID'),
        Username: email,
        SecretHash: secretHash,
      });
      const result = await this.client.send(command);
      this.lastResend[email] = now;
      return result;
    } catch (error) {
      if (error.name === 'UserNotFoundException') {
        throw new BadRequestException(
          'Usuario no encontrado. Regístrate primero.',
        );
      }
      throw new InternalServerErrorException('Error al reenviar código.');
    }
  }

  async adminConfirmSignUp(username: string) {
    try {
      const command = new AdminConfirmSignUpCommand({
        UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
        Username: username,
      });
      return this.client.send(command);
    } catch (error) {
      throw new InternalServerErrorException(
        'Error al confirmar usuario manualmente.',
      );
    }
  }
}
