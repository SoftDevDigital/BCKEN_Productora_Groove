import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

@Injectable()
export class UsersService {
  private readonly tableName = 'Users-v2';
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
  }

  async createOrUpdateUser(userId: string, role: string) {
    const params = {
      TableName: this.tableName,
      Item: {
        id: userId,
        role,
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
      ReturnValues: 'ALL_NEW' as const, // Especificar como ReturnValue
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
}
