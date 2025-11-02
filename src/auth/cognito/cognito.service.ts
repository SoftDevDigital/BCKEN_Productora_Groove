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
  AdminGetUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { UsersService } from '../../users/users.service'; // Importar UsersService

@Injectable()
export class CognitoService {
  private client: CognitoIdentityProviderClient;
  private lastResend: { [email: string]: number } = {};
  private readonly validRoles = ['User', 'Reseller', 'Admin'];

  constructor(
    private configService: ConfigService,
    private usersService: UsersService, // Inyectar UsersService
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
      return {
        UserSub: result.UserSub,
        CodeDeliveryDetails: result.CodeDeliveryDetails,
      };
    } catch (error) {
      if (error.name === 'UsernameExistsException') {
        throw error;
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
      if (!this.validRoles.includes(role)) {
        throw new BadRequestException(
          'Rol inválido. Use: User, Reseller o Admin.',
        );
      }
      
      // 1. Actualizar rol en Cognito
      const command = new AdminUpdateUserAttributesCommand({
        UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
        Username: userSub,
        UserAttributes: [{ Name: 'custom:role', Value: role }],
      });
      await this.client.send(command);
      
      // 2. Actualizar rol en DynamoDB también, con búsqueda robusta
      // Obtener email real de Cognito para asegurar coherencia
      const cognitoUser = await this.client.send(
        new AdminGetUserCommand({
          UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
          Username: userSub,
        }),
      );
      const attrs = (cognitoUser.UserAttributes || []).reduce(
        (acc: Record<string, string>, a) => ((acc[a.Name as string] = a.Value || ''), acc),
        {},
      );
      const email = attrs['email'] || '';
      const existing = await this.usersService.findUserForRoleSync(userSub, email);
      await this.usersService.createOrUpdateUser(
        existing?.id || userSub,
        role,
        existing?.email || email || userSub,
      );
      console.log(`Rol actualizado en DynamoDB: ${(existing?.id || userSub)} -> ${role}`);
      
      return { message: 'Rol actualizado exitosamente' };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException('Error al asignar rol.');
    }
  }

  async syncAllUserRoles() {
    try {
      const users = await this.usersService.getAllUsers();
      const syncResults: Array<{
        userId: string;
        email: string;
        status: 'updated' | 'already_synced' | 'error';
        oldRole?: string;
        newRole?: string;
        role?: string;
        error?: string;
      }> = [];
      
      for (const user of users) {
        try {
          // Obtener el rol actual de Cognito
          const cognitoUser = await this.client.send(
            new AdminGetUserCommand({
              UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
              Username: user.id,
            }),
          );
          
          const cognitoRole = cognitoUser.UserAttributes?.find(
            attr => attr.Name === 'custom:role'
          )?.Value || 'User';
          
          // Si el rol en DynamoDB es diferente al de Cognito, actualizar DynamoDB
          if (user.role !== cognitoRole) {
            await this.usersService.createOrUpdateUser(user.id, cognitoRole, user.email);
            syncResults.push({
              userId: user.id,
              email: user.email,
              oldRole: user.role,
              newRole: cognitoRole,
              status: 'updated'
            });
            console.log(`Rol sincronizado: ${user.id} (${user.email}) ${user.role} -> ${cognitoRole}`);
          } else {
            syncResults.push({
              userId: user.id,
              email: user.email,
              role: user.role,
              status: 'already_synced'
            });
          }
        } catch (error: any) {
          console.error(`Error sincronizando usuario ${user.id}:`, error);
          syncResults.push({
            userId: user.id,
            email: user.email,
            status: 'error',
            error: (error && (error.message || String(error)))
          });
        }
      }
      
      return {
        totalUsers: users.length,
        synced: syncResults.filter(r => r.status === 'updated').length,
        alreadySynced: syncResults.filter(r => r.status === 'already_synced').length,
        errors: syncResults.filter(r => r.status === 'error').length,
        details: syncResults
      };
    } catch (error) {
      console.error('Error en syncAllUserRoles:', error);
      throw new InternalServerErrorException('Error al sincronizar roles de usuarios');
    }
  }

  async adminDeleteUser(userSub: string) {
    console.log('=== ADMIN DELETE USER (Cognito Service) ===');
    console.log('Received userSub:', userSub);
    try {
      let deletedFromDynamoDB = false;
      let deletedFromCognito = false;
      let deletedDynamoUserId: string | null = null;
      
      // 1. Buscar usuario en DynamoDB - userSub puede ser email o sub de Cognito
      console.log('Step 1: Searching user in DynamoDB...');
      let user;
      try {
        user = await this.usersService.findUserForRoleSync(userSub, userSub);
        console.log('findUserForRoleSync result:', {
          found: !!user,
          userId: user?.id,
          email: user?.email,
          role: user?.role,
        });
      } catch (searchError: any) {
        console.error('Error searching user in DynamoDB:', searchError?.message);
        user = null;
        // Continuar aunque falle la búsqueda
      }
      
      if (user) {
        // 2. Usuario encontrado en DynamoDB - eliminar de DynamoDB primero
        console.log('Step 2: User found in DynamoDB, deleting from DynamoDB first...');
        try {
          await this.usersService.deleteUserDirect(user.id);
          deletedFromDynamoDB = true;
          deletedDynamoUserId = user.id;
          console.log(`Usuario eliminado de DynamoDB: ${user.id}`);
        } catch (dbError: any) {
          console.error(`Error eliminando de DynamoDB: ${dbError.message}`);
        }
        
        // 3. Eliminar de Cognito - usar el email del usuario encontrado
        if (user.email) {
          console.log('Step 3: Deleting user from Cognito using email:', user.email);
          const cognitoUserPoolId = this.configService.get<string>('COGNITO_USER_POOL_ID');
          console.log('Cognito UserPoolId:', cognitoUserPoolId);
          try {
            await this.client.send(
              new AdminDeleteUserCommand({
                UserPoolId: cognitoUserPoolId,
                Username: user.email,
              }),
            );
            deletedFromCognito = true;
            console.log(`Usuario eliminado de Cognito: ${user.email}`);
          } catch (cognitoError: any) {
            console.log('Cognito deletion error:', {
              name: cognitoError?.name,
              message: cognitoError?.message,
            });
            if (cognitoError?.name === 'UserNotFoundException') {
              console.warn(`Usuario ${user.email} no encontrado en Cognito`);
            } else {
              console.error('Error inesperado eliminando de Cognito:', cognitoError?.message);
              // No lanzar excepción, solo loguear
            }
          }
        } else {
          console.warn('User has no email, cannot delete from Cognito');
        }
      } else {
        // 4. No encontrado en DynamoDB - intentar eliminar de Cognito asumiendo que userSub es email
        console.warn(`Usuario ${userSub} no encontrado en DynamoDB, intentando eliminar de Cognito`);
        console.log('Attempting to delete from Cognito using userSub as username');
        const cognitoUserPoolId = this.configService.get<string>('COGNITO_USER_POOL_ID');
        console.log('Cognito UserPoolId:', cognitoUserPoolId);
        try {
          await this.client.send(
            new AdminDeleteUserCommand({
              UserPoolId: cognitoUserPoolId,
              Username: userSub,
            }),
          );
          deletedFromCognito = true;
          console.log(`Usuario eliminado de Cognito: ${userSub}`);
        } catch (cognitoError: any) {
          console.log('Cognito deletion error:', {
            name: cognitoError?.name,
            message: cognitoError?.message,
          });
          if (cognitoError?.name === 'UserNotFoundException') {
            console.warn(`Usuario ${userSub} no encontrado en Cognito`);
          } else {
            console.error('Error inesperado eliminando de Cognito:', cognitoError?.message);
            // No lanzar excepción, solo loguear
          }
        }
      }
      
      const result = {
        userSub,
        deletedFromDynamoDB,
        deletedDynamoUserId,
        deletedFromCognito,
        message: deletedFromDynamoDB || deletedFromCognito 
          ? 'Usuario eliminado completamente del sistema' 
          : 'Usuario no encontrado en ningún sistema'
      };
      console.log('Final result:', result);
      return result;
    } catch (error: any) {
      console.error('Error en adminDeleteUser (non-critical):', error);
      console.error('Error details:', {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
      });
      // Nunca lanzar excepción, siempre retornar resultado
      return {
        userSub,
        deletedFromDynamoDB: false,
        deletedDynamoUserId: null,
        deletedFromCognito: false,
        message: `Error al eliminar usuario: ${error?.message || 'Error desconocido'}`,
        error: error?.name || 'UNKNOWN_ERROR',
      };
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
      const result = await this.client.send(command);

      // Crear o actualizar usuario en DynamoDB tras confirmación
      await this.usersService.createOrUpdateUser(email, 'User', email);

      return result;
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
      const result = await this.client.send(command);

      // Crear o actualizar usuario en DynamoDB tras confirmación administrativa
      await this.usersService.createOrUpdateUser(username, 'User', username);

      return result;
    } catch (error) {
      throw new InternalServerErrorException(
        'Error al confirmar usuario manualmente.',
      );
    }
  }
}
