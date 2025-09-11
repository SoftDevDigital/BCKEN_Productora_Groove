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
import { UsersService } from '../../users/users.service';
import * as crypto from 'crypto';

@Injectable()
export class CognitoService {
  private client: CognitoIdentityProviderClient;
  private lastResend: { [email: string]: number } = {};
  private readonly validRoles = ['User', 'Reseller', 'Admin'];

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
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
      if (!result.UserSub) {
        throw new InternalServerErrorException(
          'No se pudo obtener el UserSub del usuario registrado.',
        );
      }
      await this.usersService.createOrUpdateUser(result.UserSub, 'User', email);
      return {
        statusCode: 201,
        message:
          'Usuario registrado exitosamente. Verifica tu email para confirmar.',
        userSub: result.UserSub,
        codeDeliveryDetails: result.CodeDeliveryDetails,
      };
    } catch (error) {
      if (error.name === 'UsernameExistsException') {
        throw new BadRequestException(
          'El email ya está registrado. Intenta con signin.',
        );
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
      const result = await this.client.send(command);
      return {
        statusCode: 200,
        message: 'Login exitoso',
        accessToken: result.AuthenticationResult?.AccessToken,
        idToken: result.AuthenticationResult?.IdToken,
        refreshToken: result.AuthenticationResult?.RefreshToken,
        expiresIn: result.AuthenticationResult?.ExpiresIn,
      };
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
      if (!this.validRoles.includes(role)) {
        throw new BadRequestException(
          'Rol inválido. Use: User, Reseller o Admin.',
        );
      }
      const command = new AdminUpdateUserAttributesCommand({
        UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
        Username: userSub,
        UserAttributes: [{ Name: 'custom:role', Value: role }],
      });
      await this.client.send(command);
      const user = await this.usersService.getUserProfile(userSub);
      await this.usersService.createOrUpdateUser(userSub, role, user.email);
      return {
        statusCode: 200,
        message: `Rol "${role}" asignado exitosamente al usuario ${userSub}`,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
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
      await this.client.send(command);
      return {
        statusCode: 200,
        message: 'Email confirmado exitosamente. Ahora puedes iniciar sesión.',
      };
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
      if (now - lastResendTime < 60000) {
        throw new BadRequestException(
          'Debes esperar 1 minuto desde el último reenvío.',
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
      return {
        statusCode: 200,
        message: 'Código reenviado exitosamente. Revisa tu email.',
        codeDeliveryDetails: result.CodeDeliveryDetails,
      };
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
      await this.client.send(command);
      return {
        statusCode: 200,
        message: 'Usuario confirmado manualmente',
      };
    } catch (error) {
      throw new InternalServerErrorException(
        'Error al confirmar usuario manualmente.',
      );
    }
  }
}
