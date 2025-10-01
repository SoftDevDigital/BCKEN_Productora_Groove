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
    const normalized = (emailOrAlias || '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    try {
      // Realizamos un scan completo y aplicamos coincidencia case-insensitive en memoria
      // para evitar fallos por mayúsculas/minúsculas o espacios accidentales.
      const result = await this.docClient.send(
        new ScanCommand({ TableName: this.tableName }),
      );
      const items = (result.Items || []) as User[];
      const found = items.find((u: any) => {
        const email = (u.email || '').toLowerCase();
        const alias = (u.alias || '').toLowerCase();
        return email === normalized || alias === normalized;
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

  async deleteUser(userId: string): Promise<{ message: string }> {
    try {
      // First, check if user exists in DynamoDB
      const user = await this.docClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { id: userId },
        }),
      );

      if (!user.Item) {
        throw new NotFoundException(`Usuario no encontrado: ${userId}`);
      }

      // Delete user from DynamoDB
      await this.docClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { id: userId },
        }),
      );

      // Delete user from Cognito (if exists)
      try {
        await this.cognitoClient.send(
          new AdminDeleteUserCommand({
            UserPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID'),
            Username: userId,
          }),
        );
      } catch (cognitoError) {
        console.warn(`User ${userId} not found in Cognito or already deleted:`, cognitoError.message);
        // Continue even if Cognito deletion fails
      }

      console.log(`Usuario ${userId} eliminado exitosamente`);
      return { message: `Usuario ${userId} eliminado exitosamente` };
    } catch (error) {
      console.error('Error al eliminar usuario:', error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Error al eliminar usuario: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
