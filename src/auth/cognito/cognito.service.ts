import { Injectable, BadRequestException } from '@nestjs/common';
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
  // Almacena el timestamp del último reenvío por email (simplificación para dev)
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
    const hash = crypto
      .createHmac('sha256', clientSecret)
      .update(message)
      .digest('base64');
    return hash;
  }

  async signUp(
    name: string,
    last_name: string,
    email: string,
    password: string,
  ) {
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
      ],
    });
    const result = await this.client.send(command);
    return {
      UserSub: result.UserSub,
      CodeDeliveryDetails: result.CodeDeliveryDetails,
    };
  }

  async signIn(email: string, password: string) {
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
  }

  async adminAssignRole(userSub: string, role: string) {
    const command = new AdminUpdateUserAttributesCommand({
      UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
      Username: userSub,
      UserAttributes: [{ Name: 'custom:role', Value: role }],
    });
    return this.client.send(command);
  }

  async confirmSignUp(email: string, confirmationCode: string) {
    const secretHash = this.getSecretHash(email);
    const command = new ConfirmSignUpCommand({
      ClientId: this.configService.get<string>('COGNITO_CLIENT_ID'),
      Username: email,
      ConfirmationCode: confirmationCode,
      SecretHash: secretHash,
    });
    return this.client.send(command);
  }

  async resendConfirmation(email: string) {
    const now = Date.now();
    const lastResendTime = this.lastResend[email] || 0;
    const timeSinceLastResend = now - lastResendTime;

    if (timeSinceLastResend < 300000) {
      // 5 minutos = 300,000 ms
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
    this.lastResend[email] = now; // Actualiza timestamp
    return result;
  }

  async adminConfirmSignUp(username: string) {
    const command = new AdminConfirmSignUpCommand({
      UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
      Username: username,
    });
    return this.client.send(command);
  }
}
