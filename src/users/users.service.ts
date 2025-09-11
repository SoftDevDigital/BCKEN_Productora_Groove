import {
  Injectable,
  Inject,
  HttpException,
  HttpStatus,
  forwardRef,
} from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SalesService } from '../sales/sales.service';
import { EventsService } from '../events/events.service';
import { BatchesService } from '../batches/batches.service';
import { generateAlias } from '../utils/generate-alias';

@Injectable()
export class UsersService {
  private readonly tableName = 'Users-v2';
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    @Inject(forwardRef(() => SalesService))
    private readonly salesService: SalesService,
    private readonly eventsService: EventsService,
    private readonly batchesService: BatchesService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
  }

  async createOrUpdateUser(userId: string, role: string, email: string) {
    let alias: string;
    let attempts = 0;
    const maxAttempts = 5;

    // Generar alias único
    do {
      alias = generateAlias();
      const existing = await this.docClient.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: '#alias = :alias',
          ExpressionAttributeNames: { '#alias': 'alias' },
          ExpressionAttributeValues: { ':alias': alias },
        }),
      );
      if (existing.Items?.length === 0) break;
      attempts++;
      if (attempts >= maxAttempts) {
        throw new HttpException(
          'No se pudo generar un alias único',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } while (true);

    const params = {
      TableName: this.tableName,
      Item: {
        id: userId,
        role,
        email,
        alias,
        purchasedTickets: [],
        soldTickets: role === 'Reseller' ? [] : undefined,
        createdAt: new Date().toISOString(),
      },
    };
    try {
      await this.docClient.send(new PutCommand(params));
      return {
        userId,
        role,
        email,
        alias,
        purchasedTickets: [],
        soldTickets: role === 'Reseller' ? [] : undefined,
      };
    } catch (error) {
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
    const updateExpressionParts: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    updateExpressionParts.push(
      'SET #purchasedTickets = list_append(if_not_exists(#purchasedTickets, :empty_list), :ticketIds)',
    );
    expressionAttributeNames['#purchasedTickets'] = 'purchasedTickets';
    expressionAttributeValues[':ticketIds'] = ticketIds;
    expressionAttributeValues[':empty_list'] = [];

    if (resellerId) {
      updateExpressionParts.push(
        'SET #soldTickets = list_append(if_not_exists(#soldTickets, :empty_list), :ticketIds)',
      );
      expressionAttributeNames['#soldTickets'] = 'soldTickets';
    }

    const params = {
      TableName: this.tableName,
      Key: { id: userId },
      UpdateExpression: updateExpressionParts.join(', '),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW' as const,
    };

    try {
      const result = await this.docClient.send(new UpdateCommand(params));
      return result.Attributes;
    } catch (error) {
      throw new HttpException(
        'Error al actualizar tickets de usuario',
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
        throw new HttpException('Usuario no encontrado', HttpStatus.NOT_FOUND);
      }
      return result.Item;
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

  async getAllUsers() {
    const params = {
      TableName: this.tableName,
    };
    try {
      const result = await this.docClient.send(new ScanCommand(params));
      return result.Items || [];
    } catch (error) {
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
      throw new HttpException(
        'Error al obtener compras del usuario',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async findUserByAlias(alias: string) {
    const params = {
      TableName: this.tableName,
      FilterExpression: '#alias = :alias',
      ExpressionAttributeNames: { '#alias': 'alias' },
      ExpressionAttributeValues: { ':alias': alias },
    };
    try {
      const result = await this.docClient.send(new ScanCommand(params));
      return result.Items?.[0] || null;
    } catch (error) {
      throw new HttpException(
        'Error al buscar usuario por alias',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
