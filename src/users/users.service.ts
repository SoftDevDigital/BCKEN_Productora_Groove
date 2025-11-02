import {
  Injectable,
  Inject,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { EventsService } from '../events/events.service';
import { BatchesService } from '../batches/batches.service';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ConfigService } from '@nestjs/config';
import { User } from './users/types';
@Injectable()
export class UsersService {
  private readonly tableName = 'Users-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly cognitoClient: CognitoIdentityProviderClient;
  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private readonly eventsService: EventsService,
    private readonly batchesService: BatchesService,
    private readonly configService: ConfigService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
    this.cognitoClient = new CognitoIdentityProviderClient({
      region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
    });
  }
  async createOrUpdateUser(userId: string, role: string, email: string) {
    const params = {
      TableName: this.tableName,
      Item: {
        id: userId,
        role,
        email,
        purchasedTickets: [],
        soldTickets: role === 'Reseller' ? [] : undefined,
        createdAt: new Date().toISOString(),
      },
    };
    try {
      await this.docClient.send(new PutCommand(params));
      console.log('Usuario creado/actualizado:', { userId, role, email });
      return {
        userId,
        role,
        email,
        purchasedTickets: [],
        soldTickets: role === 'Reseller' ? [] : undefined,
      };
    } catch (error) {
      console.error('Error al crear/actualizar usuario:', error);
      throw new HttpException(
        'Error al crear/actualizar usuario',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  async updateUserTickets(
    userId: string,
    ticketIds: string[],
    resellerId?: string,
  ) {
    try {
      // Verificar si el usuario existe
      const user = await this.getUserProfile(userId);
      if (!user) {
        throw new NotFoundException(`Usuario no encontrado: ${userId}`);
      }
      const updateExpressionParts: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      // Actualizar purchasedTickets
      updateExpressionParts.push(
        '#purchasedTickets = list_append(if_not_exists(#purchasedTickets, :empty_list), :ticketIds)',
      );
      expressionAttributeNames['#purchasedTickets'] = 'purchasedTickets';
      expressionAttributeValues[':ticketIds'] = ticketIds;
      expressionAttributeValues[':empty_list'] = [];

      if (resellerId) {
        // Verificar si el reseller existe
        const reseller = await this.getUserProfile(resellerId);
        if (!reseller) {
          throw new NotFoundException(
            `Revendedor no encontrado: ${resellerId}`,
          );
        }
        // Actualizar soldTickets
        updateExpressionParts.push(
          '#soldTickets = list_append(if_not_exists(#soldTickets, :empty_list), :ticketIds)',
        );
        expressionAttributeNames['#soldTickets'] = 'soldTickets';
      }

      const params = {
        TableName: this.tableName,
        Key: { id: userId },
        UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW' as const,
      };

      console.log('Ejecutando UpdateCommand:', {
        userId,
        params: JSON.stringify(params),
      });
      const result = await this.docClient.send(new UpdateCommand(params));
      console.log('Tickets actualizados para usuario:', {
        userId,
        ticketIds,
        resellerId,
        updatedAttributes: result.Attributes,
      });
      return result.Attributes;
    } catch (error) {
      console.error('Error al actualizar tickets de usuario:', {
        userId,
        ticketIds,
        resellerId,
        error: error.message,
      });
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new HttpException(
        `Error al actualizar tickets de usuario: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  async getUserProfile(userId: string) {
    const params = {
      TableName: this.tableName,
      Key: { id: userId },
    };
    try {
      const result = await this.docClient.send(new GetCommand(params));
      if (!result.Item) {
        throw new NotFoundException(`Usuario no encontrado: ${userId}`);
      }
      return result.Item;
    } catch (error) {
      console.error('Error al obtener perfil:', error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new HttpException(
        'Error al obtener perfil',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  async getUserByEmailOrAlias(emailOrAlias: string): Promise<User | null> {
    const raw = (emailOrAlias || '').trim();
    const normalized = raw.toLowerCase();
    if (!raw) {
      return null;
    }
    try {
      // 1) Intentar buscar por id == email enviado (algunos usuarios usan email como id)
      try {
        const byId = await this.docClient.send(
          new GetCommand({ TableName: this.tableName, Key: { id: raw } }),
        );
        if (byId.Item) {
          return byId.Item as User;
        }
      } catch (inner) {
        // Continuar con la búsqueda secundaria si falla el Get
      }

      // 2) Buscar por email usando EmailIndex (más eficiente que Scan)
      try {
        const byEmail = await this.docClient.send(
          new QueryCommand({
            TableName: this.tableName,
            IndexName: 'EmailIndex',
            KeyConditionExpression: 'email = :email',
            ExpressionAttributeValues: { ':email': raw },
          }),
        );
        if (byEmail.Items && byEmail.Items.length > 0) {
          // Buscar coincidencia exacta (case-insensitive)
          const found = byEmail.Items.find((u: any) => 
            (u.email || '').toLowerCase() === normalized
          ) as User | undefined;
          if (found) {
            return found;
          }
          // Si no hay coincidencia exacta pero hay resultados, devolver el primero
          // (aunque esto no debería pasar si el email coincide exactamente)
          return byEmail.Items[0] as User;
        }
      } catch (queryError) {
        console.log('Query by email index failed, falling back to scan:', queryError.message);
      }

      // 3) Si el índice falla, buscar por alias usando AliasIndex
      try {
        const byAlias = await this.docClient.send(
          new QueryCommand({
            TableName: this.tableName,
            IndexName: 'AliasIndex',
            KeyConditionExpression: 'alias = :alias',
            ExpressionAttributeValues: { ':alias': raw },
          }),
        );
        if (byAlias.Items && byAlias.Items.length > 0) {
          const found = byAlias.Items.find((u: any) => 
            (u.alias || '').toLowerCase() === normalized
          ) as User | undefined;
          if (found) {
            return found;
          }
          return byAlias.Items[0] as User;
        }
      } catch (aliasError) {
        console.log('Query by alias index failed, falling back to scan:', aliasError.message);
      }

      // 4) Fallback: Scan y comparar case-insensitive (último recurso, menos eficiente)
      const result = await this.docClient.send(
        new ScanCommand({ TableName: this.tableName }),
      );
      const items = (result.Items || []) as User[];
      const found = items.find((u: any) => {
        const id = (u.id || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        const alias = (u.alias || '').toLowerCase();
        return id === normalized || email === normalized || alias === normalized;
      });
      return found || null;
    } catch (error) {
      console.error('Error al buscar usuario por email o alias:', error);
      throw new HttpException(
        'Error al buscar usuario por email o alias',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Búsqueda robusta para sincronización de roles desde Cognito
  async findUserForRoleSync(
    cognitoSub: string,
    email: string,
  ): Promise<User | null> {
    console.log('=== FIND USER FOR ROLE SYNC ===');
    console.log('Searching with cognitoSub:', cognitoSub, 'email:', email);
    
    // 1) Buscar por id = sub de Cognito
    console.log('Step 1: Searching by cognitoSub as id:', cognitoSub);
    try {
      const bySub = await this.docClient.send(
        new GetCommand({ TableName: this.tableName, Key: { id: cognitoSub } }),
      );
      if (bySub.Item) {
        console.log('Found user by cognitoSub:', bySub.Item);
        return bySub.Item as User;
      }
      console.log('No user found by cognitoSub');
    } catch (err) {
      console.log('Error searching by cognitoSub:', err.message);
    }
    
    // 2) Buscar por id = email (algunos registros usan email como id)
    console.log('Step 2: Searching by email as id:', email);
    try {
      const byEmailId = await this.docClient.send(
        new GetCommand({ TableName: this.tableName, Key: { id: email } }),
      );
      if (byEmailId.Item) {
        console.log('Found user by email id:', byEmailId.Item);
        return byEmailId.Item as User;
      }
      console.log('No user found by email id');
    } catch (err) {
      console.log('Error searching by email id:', err.message);
    }
    
    // 3) Escanear por atributo email
    console.log('Step 3: Scanning by email attribute:', email);
    try {
      const scan = await this.docClient.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'email = :email',
          ExpressionAttributeValues: { ':email': email },
        }),
      );
      const item = (scan.Items || [])[0] as User | undefined;
      if (item) {
        console.log('Found user by email scan:', item);
      } else {
        console.log('No user found by email scan');
      }
      return item || null;
    } catch (error) {
      console.error('Error en findUserForRoleSync:', error);
      return null;
    }
  }
  async getAllUsers(): Promise<User[]> {
    try {
      let allUsers: any[] = [];
      let lastEvaluatedKey: any = undefined;
      
      // Paginate through all results to get complete list
      do {
        const params = {
          TableName: this.tableName,
          ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
        };
        
        const result = await this.docClient.send(new ScanCommand(params));
        allUsers = allUsers.concat(result.Items || []);
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      const enrichedUsers = await Promise.all(
        allUsers.map(async (user: any) => {
          try {
            const command = new AdminGetUserCommand({
              UserPoolId: this.configService.get<string>(
                'COGNITO_USER_POOL_ID',
              ),
              Username: user.id,
            });
            const cognitoUser = await this.cognitoClient.send(command);
            const attributes =
              cognitoUser.UserAttributes?.reduce(
                (acc, attr) => ({ ...acc, [attr.Name as string]: attr.Value }),
                {} as Record<string, string>,
              ) || {};
            return {
              ...user,
              given_name: attributes['given_name'] || 'N/A',
              family_name: attributes['family_name'] || 'N/A',
              email: attributes['email'] || user.email,
            };
          } catch (error) {
            console.error(
              `Error fetching Cognito data for user ${user.id}:`,
              error,
            );
            return {
              ...user,
              given_name: 'N/A',
              family_name: 'N/A',
              email: user.email,
            };
          }
        }),
      );
      return enrichedUsers as User[];
    } catch (error) {
      console.error('Error al listar usuarios:', error);
      throw new HttpException(
        'Error al listar usuarios',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  async getUserPurchases(userId: string) {
    try {
      const salesResult = await this.docClient.send(
        new ScanCommand({
          TableName: 'Sales-v2',
          FilterExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId },
        }),
      );
      const sales = salesResult.Items || [];
      const purchases = await Promise.all(
        sales.map(async (sale) => {
          const event = await this.eventsService.findOne(sale.eventId);
          const batch = await this.batchesService.findOne(
            sale.eventId,
            sale.batchId,
          );
          const ticketsResult = await this.docClient.send(
            new ScanCommand({
              TableName: 'Tickets-v2',
              FilterExpression: 'saleId = :saleId',
              ExpressionAttributeValues: { ':saleId': sale.id },
            }),
          );
          const tickets = ticketsResult.Items || [];
          return {
            saleId: sale.id,
            event: event
              ? {
                  id: event.id,
                  name: event.name,
                  from: event.from,
                  to: event.to,
                  location: event.location,
                }
              : null,
            batch: batch
              ? { id: batch.batchId, name: batch.name, price: batch.price }
              : null,
            quantity: sale.quantity,
            total: sale.total,
            status: sale.status,
            tickets: tickets.map((ticket) => ticket.id),
            createdAt: sale.createdAt,
          };
        }),
      );
      return purchases;
    } catch (error) {
      console.error('Error al obtener compras del usuario:', {
        userId,
        error: error.message,
      });
      throw new HttpException(
        'Error al obtener compras del usuario',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  async getUserSales(userId: string) {
    try {
      const salesResult = await this.docClient.send(
        new ScanCommand({
          TableName: 'Sales-v2',
          FilterExpression: 'resellerId = :userId AND #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':userId': userId, ':status': 'approved' },
        }),
      );
      const sales = salesResult.Items || [];
      const salesData = await Promise.all(
        sales.map(async (sale) => {
          const event = await this.eventsService.findOne(sale.eventId);
          const batch = await this.batchesService.findOne(
            sale.eventId,
            sale.batchId,
          );
          const ticketsResult = await this.docClient.send(
            new ScanCommand({
              TableName: 'Tickets-v2',
              FilterExpression: 'saleId = :saleId',
              ExpressionAttributeValues: { ':saleId': sale.id },
            }),
          );
          const tickets = ticketsResult.Items || [];
          return {
            saleId: sale.id,
            event: event
              ? {
                  id: event.id,
                  name: event.name,
                  from: event.from,
                  to: event.to,
                  location: event.location,
                }
              : null,
            batch: batch
              ? { id: batch.batchId, name: batch.name, price: batch.price }
              : null,
            quantity: sale.quantity,
            total: sale.total,
            status: sale.status,
            tickets: tickets.map((ticket) => ticket.id),
            createdAt: sale.createdAt,
          };
        }),
      );
      console.log('Ventas obtenidas para revendedor:', {
        userId,
        sales: salesData,
      });
      return salesData;
    } catch (error) {
      console.error('Error al obtener ventas del revendedor:', {
        userId,
        error: error.message,
      });
      throw new HttpException(
        'Error al obtener ventas del revendedor',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async deleteUserDirect(userId: string): Promise<void> {
    console.log('=== DELETE USER DIRECT ===');
    console.log('Attempting to delete from DynamoDB only, userId:', userId);
    try {
      // Delete user from DynamoDB only (sin eliminar de Cognito)
      // No verificar si existe primero, simplemente intentar eliminar
      console.log('DeleteCommand params:', {
        TableName: this.tableName,
        Key: { id: userId },
      });
      await this.docClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { id: userId },
        }),
      );
      console.log(`Usuario ${userId} eliminado de DynamoDB`);
    } catch (error: any) {
      console.error('Error al eliminar usuario de DynamoDB:', error);
      console.error('Error details:', {
        message: error.message,
        name: error.name,
      });
      // No lanzar error, solo loguear - la eliminación puede fallar si no existe
      console.warn(`No se pudo eliminar usuario ${userId} de DynamoDB: ${error.message}`);
    }
  }

  async deleteUser(userId: string): Promise<{ message: string }> {
    console.log('=== DELETE USER SERVICE ===');
    console.log('Attempting to delete userId:', userId);
    
    let actualUserId: string | null = null;
    let userEmail: string | null = null;
    let deletedFromDynamoDB = false;
    let deletedFromCognito = false;
    
    try {
      // First, check if user exists in DynamoDB by id
      console.log('Step 1: Checking if user exists in DynamoDB by id...');
      console.log('TableName:', this.tableName);
      console.log('Key:', { id: userId });
      
      let user;
      try {
        user = await this.docClient.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { id: userId },
          }),
        );
        console.log('DynamoDB GetCommand result (by id):', {
          hasItem: !!user.Item,
          item: user.Item,
        });
      } catch (dbError: any) {
        console.error('Error querying DynamoDB by id:', dbError.message);
        user = { Item: null };
      }

      // If not found by id, try to find by email (userId might be an email)
      if (!user.Item) {
        console.log('User not found by id, trying to search by email/alias...');
        try {
          const userByEmail = await this.getUserByEmailOrAlias(userId);
          if (userByEmail) {
            console.log('User found by email/alias:', {
              id: userByEmail.id,
              email: userByEmail.email,
            });
            actualUserId = userByEmail.id;
            userEmail = userByEmail.email || userId;
          } else {
            console.warn('User not found in DynamoDB by id or email:', userId);
            // No lanzar error, solo retornar mensaje
            return { message: `Usuario no encontrado en DynamoDB: ${userId}` };
          }
        } catch (searchError: any) {
          console.error('Error searching by email/alias:', searchError.message);
          return { message: `Error al buscar usuario: ${searchError.message}` };
        }
      } else {
        actualUserId = user.Item.id;
        userEmail = user.Item.email || userId;
      }

      console.log('Will delete user with:', { actualUserId, userEmail });

      // Delete user from DynamoDB using the actual id found
      if (actualUserId) {
        console.log('Step 2: Deleting user from DynamoDB...');
        console.log('Using actual userId:', actualUserId);
        try {
          await this.docClient.send(
            new DeleteCommand({
              TableName: this.tableName,
              Key: { id: actualUserId },
            }),
          );
          deletedFromDynamoDB = true;
          console.log('DynamoDB DeleteCommand successful');
        } catch (dbDeleteError: any) {
          console.error('Error deleting from DynamoDB:', dbDeleteError.message);
          // Continuar aunque falle la eliminación de DB
        }
      }

      // Delete user from Cognito (if exists)
      // Use email as Username in Cognito (since username_attributes = ["email"])
      if (userEmail) {
        console.log('Step 3: Attempting to delete user from Cognito...');
        const cognitoUserPoolId = this.configService.get<string>('COGNITO_USER_POOL_ID');
        console.log('Cognito UserPoolId:', cognitoUserPoolId);
        console.log('Cognito Username (email):', userEmail);
        
        try {
          await this.cognitoClient.send(
            new AdminDeleteUserCommand({
              UserPoolId: cognitoUserPoolId,
              Username: userEmail, // Use email as Username in Cognito
            }),
          );
          deletedFromCognito = true;
          console.log('Cognito AdminDeleteUserCommand successful');
        } catch (cognitoError: any) {
          console.warn(`User ${userEmail} not found in Cognito or already deleted:`, cognitoError.message);
          console.log('Cognito deletion failed, but continuing...');
          // Continue even if Cognito deletion fails
        }
      }

      // Retornar resultado basado en lo que se eliminó
      if (deletedFromDynamoDB && deletedFromCognito) {
        return { message: `Usuario ${actualUserId} (${userEmail}) eliminado exitosamente de ambos sistemas` };
      } else if (deletedFromDynamoDB) {
        return { message: `Usuario ${actualUserId} eliminado de DynamoDB. Error al eliminar de Cognito.` };
      } else if (deletedFromCognito) {
        return { message: `Usuario ${userEmail} eliminado de Cognito. Error al eliminar de DynamoDB.` };
      } else {
        return { message: `No se pudo eliminar el usuario ${userId} de ningún sistema` };
      }
    } catch (error: any) {
      console.error('Error inesperado al eliminar usuario:', error);
      console.error('Error details:', {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
      });
      // Nunca lanzar excepción, siempre retornar mensaje
      return { 
        message: `Error al procesar eliminación de usuario: ${error?.message || 'Error desconocido'}` 
      };
    }
  }
}
