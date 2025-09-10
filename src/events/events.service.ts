import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class EventsService {
  private readonly tableName = 'Events-v2';
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
        date: createEventDto.date,
        location: createEventDto.location,
        totalTickets: createEventDto.totalTickets,
        availableTickets: createEventDto.totalTickets,
        createdAt: new Date().toISOString(),
      },
    };

    try {
      await this.docClient.send(new PutCommand(params));
      return { id: eventId, ...createEventDto };
    } catch (error) {
      throw new HttpException(
        'Error al crear evento en DynamoDB',
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
      return result.Items;
    } catch (error) {
      throw new HttpException(
        'Error al listar eventos',
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
      return result.Item;
    } catch (error) {
      throw new HttpException(
        'Error al obtener evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async update(id: string, updateEventDto: UpdateEventDto) {
    const params: UpdateCommandInput = {
      TableName: this.tableName,
      Key: { id },
      UpdateExpression:
        'SET #name = :name, #date = :date, #location = :location, #totalTickets = :totalTickets, #availableTickets = :availableTickets',
      ExpressionAttributeNames: {
        '#name': 'name',
        '#date': 'date',
        '#location': 'location',
        '#totalTickets': 'totalTickets',
        '#availableTickets': 'availableTickets',
      },
      ExpressionAttributeValues: {
        ':name': updateEventDto.name,
        ':date': updateEventDto.date,
        ':location': updateEventDto.location,
        ':totalTickets': updateEventDto.totalTickets,
        ':availableTickets': updateEventDto.totalTickets,
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
        'Error al actualizar evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async remove(id: string) {
    const params = {
      TableName: this.tableName,
      Key: { id },
    };
    try {
      await this.docClient.send(new DeleteCommand(params));
      return true;
    } catch (error) {
      throw new HttpException(
        'Error al eliminar evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async decrementTickets(eventId: string, quantity: number) {
    const params: UpdateCommandInput = {
      TableName: this.tableName,
      Key: { id: eventId },
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
        'No hay tickets suficientes o error al decrementar',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
