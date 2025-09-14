import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
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
import { v4 as uuidv4 } from 'uuid';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

@Injectable()
export class EventsService {
  private readonly tableName = 'Events-v2';
  private readonly batchesTableName = 'Batches-v2';
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
  }

  async create(createEventDto: CreateEventDto) {
    const eventId = uuidv4();
    const params = {
      TableName: this.tableName,
      Item: {
        id: eventId,
        name: createEventDto.name,
        from: createEventDto.from,
        to: createEventDto.to,
        location: createEventDto.location,
        createdAt: new Date().toISOString(),
      },
    };
    try {
      await this.docClient.send(new PutCommand(params));
      return { id: eventId, ...createEventDto };
    } catch (error) {
      throw new HttpException(
        'Error al crear evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async findAll() {
    const params = {
      TableName: this.tableName,
    };
    try {
      const result = await this.docClient.send(new ScanCommand(params));
      return result.Items || [];
    } catch (error) {
      throw new HttpException(
        'Error al obtener eventos',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async findOne(id: string) {
    const params = {
      TableName: this.tableName,
      Key: { id },
    };
    try {
      const result = await this.docClient.send(new GetCommand(params));
      return result.Item || null;
    } catch (error) {
      throw new HttpException(
        'Error al obtener evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async update(id: string, updateEventDto: UpdateEventDto) {
    const updateExpressionParts: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    if (updateEventDto.name) {
      updateExpressionParts.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = updateEventDto.name;
    }
    if (updateEventDto.from) {
      updateExpressionParts.push('#from = :from');
      expressionAttributeNames['#from'] = 'from';
      expressionAttributeValues[':from'] = updateEventDto.from;
    }
    if (updateEventDto.to) {
      updateExpressionParts.push('#to = :to');
      expressionAttributeNames['#to'] = 'to';
      expressionAttributeValues[':to'] = updateEventDto.to;
    }
    if (updateEventDto.location) {
      updateExpressionParts.push('#location = :location');
      expressionAttributeNames['#location'] = 'location';
      expressionAttributeValues[':location'] = updateEventDto.location;
    }
    if (updateExpressionParts.length === 0) {
      throw new HttpException(
        'No se proporcionaron datos para actualizar',
        HttpStatus.BAD_REQUEST,
      );
    }
    updateExpressionParts.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();

    const params = {
      TableName: this.tableName,
      Key: { id },
      UpdateExpression: 'SET ' + updateExpressionParts.join(', '),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW' as const,
    };

    try {
      const result = await this.docClient.send(new UpdateCommand(params));
      return result.Attributes;
    } catch (error) {
      throw new HttpException(
        'Error al actualizar evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async delete(id: string) {
    // Buscar todas las tandas asociadas al evento
    const batchParams = {
      TableName: this.batchesTableName,
      KeyConditionExpression: 'eventId = :eventId',
      ExpressionAttributeValues: {
        ':eventId': id,
      },
    };

    try {
      // Opcional: Validar si hay ventas asociadas (descomentar si es necesario)
      /*
      const salesParams = {
        TableName: 'Sales-v2',
        FilterExpression: 'eventId = :eventId',
        ExpressionAttributeValues: { ':eventId': id },
      };
      const salesResult = await this.docClient.send(new ScanCommand(salesParams));
      if (salesResult.Items && salesResult.Items.length > 0) {
        throw new HttpException(
          'No se puede eliminar el evento porque tiene ventas asociadas',
          HttpStatus.BAD_REQUEST,
        );
      }
      */

      // Obtener y eliminar todas las tandas asociadas
      const batchResult = await this.docClient.send(
        new QueryCommand(batchParams),
      );
      const batches = batchResult.Items || [];

      for (const batch of batches) {
        const deleteBatchParams = {
          TableName: this.batchesTableName,
          Key: { eventId: id, batchId: batch.batchId },
        };
        await this.docClient.send(new DeleteCommand(deleteBatchParams));
      }

      // Eliminar el evento
      const eventParams = {
        TableName: this.tableName,
        Key: { id },
      };
      await this.docClient.send(new DeleteCommand(eventParams));

      return { message: `Evento ${id} y sus tandas asociadas eliminados` };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al eliminar evento y sus tandas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
