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
        price: createBatchDto.price,
        isVip: createBatchDto.isVip, // Nuevo campo
        startTime: createBatchDto.startTime, // Horario de inicio
        endTime: createBatchDto.endTime, // Horario de finalización
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
      return result.Items || [];
    } catch (error) {
      throw new HttpException(
        'Error al listar tandas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async findOne(eventId: string, batchId: string) {
    const params = {
      TableName: this.tableName,
      Key: { eventId, batchId },
    };
    try {
      const result = await this.docClient.send(new GetCommand(params));
      return result.Item;
    } catch (error) {
      throw new HttpException(
        'Error al obtener tanda',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async update(
    eventId: string,
    batchId: string,
    updateBatchDto: UpdateBatchDto,
  ) {
    const updateExpressionParts: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    if (updateBatchDto.name !== undefined) {
      updateExpressionParts.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = updateBatchDto.name;
    }
    if (updateBatchDto.totalTickets !== undefined) {
      updateExpressionParts.push('#totalTickets = :totalTickets');
      updateExpressionParts.push('#availableTickets = :availableTickets');
      expressionAttributeNames['#totalTickets'] = 'totalTickets';
      expressionAttributeNames['#availableTickets'] = 'availableTickets';
      expressionAttributeValues[':totalTickets'] = updateBatchDto.totalTickets;
      expressionAttributeValues[':availableTickets'] =
        updateBatchDto.totalTickets;
    }
    if (updateBatchDto.price !== undefined) {
      updateExpressionParts.push('#price = :price');
      expressionAttributeNames['#price'] = 'price';
      expressionAttributeValues[':price'] = updateBatchDto.price;
    }
    if (updateBatchDto.isVip !== undefined) {
      updateExpressionParts.push('#isVip = :isVip');
      expressionAttributeNames['#isVip'] = 'isVip';
      expressionAttributeValues[':isVip'] = updateBatchDto.isVip;
    }
    if (updateBatchDto.startTime !== undefined) {
      updateExpressionParts.push('#startTime = :startTime');
      expressionAttributeNames['#startTime'] = 'startTime';
      expressionAttributeValues[':startTime'] = updateBatchDto.startTime;
    }
    if (updateBatchDto.endTime !== undefined) {
      updateExpressionParts.push('#endTime = :endTime');
      expressionAttributeNames['#endTime'] = 'endTime';
      expressionAttributeValues[':endTime'] = updateBatchDto.endTime;
    }

    if (updateExpressionParts.length === 0) {
      throw new HttpException(
        'No se proporcionaron datos para actualizar',
        HttpStatus.BAD_REQUEST,
      );
    }

    const params: UpdateCommandInput = {
      TableName: this.tableName,
      Key: { eventId, batchId },
      UpdateExpression: 'SET ' + updateExpressionParts.join(', '),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    };

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
        ':quantity': quantity,
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
