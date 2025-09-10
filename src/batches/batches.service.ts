import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { CreateBatchDto } from './dto/create-batc.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class BatchesService {
  private readonly tableName = 'Batches-v2';
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
  }

  async create(eventId: string, createBatchDto: CreateBatchDto) {
    const batchId = uuidv4();
    const params = {
      TableName: this.tableName,
      Item: {
        eventId,
        batchId,
        name: createBatchDto.name,
        totalTickets: createBatchDto.totalTickets,
        availableTickets: createBatchDto.totalTickets,
        createdAt: new Date().toISOString(),
      },
    };

    try {
      await this.docClient.send(new PutCommand(params));
      return { batchId, ...createBatchDto };
    } catch (error) {
      throw new HttpException(
        'Error al crear tanda en DynamoDB',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async findAll(eventId: string) {
    const params = {
      TableName: this.tableName,
      KeyConditionExpression: 'eventId = :eventId',
      ExpressionAttributeValues: {
        ':eventId': eventId,
      },
    };
    try {
      const result = await this.docClient.send(new QueryCommand(params));
      return result.Items;
    } catch (error) {
      throw new HttpException(
        'Error al listar tandas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async update(
    eventId: string,
    batchId: string,
    updateBatchDto: UpdateBatchDto,
  ) {
    const params: UpdateCommandInput = {
      TableName: this.tableName,
      Key: { eventId, batchId },
      UpdateExpression:
        'SET #name = :name, #totalTickets = :totalTickets, #availableTickets = :availableTickets',
      ExpressionAttributeNames: {
        '#name': 'name',
        '#totalTickets': 'totalTickets',
        '#availableTickets': 'availableTickets',
      },
      ExpressionAttributeValues: {
        ':name': updateBatchDto.name,
        ':totalTickets': updateBatchDto.totalTickets,
        ':availableTickets': updateBatchDto.totalTickets,
      },
      ReturnValues: 'ALL_NEW',
    };

    if (params.ExpressionAttributeValues) {
      params.ExpressionAttributeValues = Object.fromEntries(
        Object.entries(params.ExpressionAttributeValues).filter(
          ([_, value]) => value !== undefined,
        ),
      );
    } else {
      params.ExpressionAttributeValues = {};
    }

    try {
      const result = await this.docClient.send(new UpdateCommand(params));
      return result.Attributes;
    } catch (error) {
      throw new HttpException(
        'Error al actualizar tanda',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async remove(eventId: string, batchId: string) {
    const params = {
      TableName: this.tableName,
      Key: { eventId, batchId },
    };
    try {
      await this.docClient.send(new DeleteCommand(params));
      return true;
    } catch (error) {
      throw new HttpException(
        'Error al eliminar tanda',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async decrementTickets(eventId: string, batchId: string, quantity: number) {
    const params: UpdateCommandInput = {
      TableName: this.tableName,
      Key: { eventId, batchId },
      UpdateExpression: 'ADD #availableTickets :decrement',
      ExpressionAttributeNames: {
        '#availableTickets': 'availableTickets',
      },
      ExpressionAttributeValues: {
        ':decrement': -quantity,
        ':quantity': quantity, // Condición para evitar negativos
      },
      ConditionExpression: '#availableTickets >= :quantity',
      ReturnValues: 'ALL_NEW',
    };

    try {
      const result = await this.docClient.send(new UpdateCommand(params));
      return result.Attributes;
    } catch (error) {
      throw new HttpException(
        'No hay tickets suficientes en la tanda o error al decrementar',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
