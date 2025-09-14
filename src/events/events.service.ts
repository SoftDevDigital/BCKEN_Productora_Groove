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
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EventsService {
  private readonly tableName = 'Events-v2';
  private readonly batchesTableName = 'Batches-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private readonly configService: ConfigService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
    });
    this.bucketName = this.configService.get<string>('S3_BUCKET') || 'ticket-qr-bucket-dev-v2';
  }

  async create(createEventDto: CreateEventDto) {
    const eventId = uuidv4();
    let imageUrl: string | undefined;

    // Subir imagen a S3 si se proporciona
    if (createEventDto.image) {
      if (!createEventDto.image.buffer || !createEventDto.image.mimetype) {
        throw new HttpException(
          'Archivo de imagen inválido',
          HttpStatus.BAD_REQUEST,
        );
      }
      const fileExtension = createEventDto.image.mimetype.split('/')[1];
      if (!['png', 'jpeg', 'jpg'].includes(fileExtension)) {
        throw new HttpException(
          'Solo se permiten imágenes PNG o JPEG',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (createEventDto.image.size > 5 * 1024 * 1024) {
        throw new HttpException(
          'La imagen no debe exceder los 5MB',
          HttpStatus.BAD_REQUEST,
        );
      }
      const imageKey = `events/event-${eventId}-${uuidv4()}.${fileExtension}`;
      try {
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: imageKey,
            Body: createEventDto.image.buffer,
            ContentType: createEventDto.image.mimetype,
          }),
        );
        imageUrl = `https://${this.bucketName}.s3.amazonaws.com/${imageKey}`;
      } catch (error) {
        console.error('Error subiendo imagen a S3:', error);
        throw new HttpException(
          `Error al subir la imagen a S3: ${error.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }

    const params = {
      TableName: this.tableName,
      Item: {
        id: eventId,
        name: createEventDto.name,
        from: createEventDto.from,
        to: createEventDto.to,
        location: createEventDto.location,
        imageUrl, // Guardar URL de la imagen (si existe)
        createdAt: new Date().toISOString(),
      },
    };

    try {
      await this.docClient.send(new PutCommand(params));
      return { id: eventId, ...createEventDto, image: undefined, imageUrl };
    } catch (error) {
      console.error('Error creando evento en DynamoDB:', error);
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

    // Subir nueva imagen a S3 si se proporciona
    if (updateEventDto.image) {
      if (!updateEventDto.image.buffer || !updateEventDto.image.mimetype) {
        throw new HttpException(
          'Archivo de imagen inválido',
          HttpStatus.BAD_REQUEST,
        );
      }
      const fileExtension = updateEventDto.image.mimetype.split('/')[1];
      if (!['png', 'jpeg', 'jpg'].includes(fileExtension)) {
        throw new HttpException(
          'Solo se permiten imágenes PNG o JPEG',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (updateEventDto.image.size > 5 * 1024 * 1024) {
        throw new HttpException(
          'La imagen no debe exceder los 5MB',
          HttpStatus.BAD_REQUEST,
        );
      }
      const imageKey = `events/event-${id}-${uuidv4()}.${fileExtension}`;
      try {
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: imageKey,
            Body: updateEventDto.image.buffer,
            ContentType: updateEventDto.image.mimetype,
          }),
        );
        const imageUrl = `https://${this.bucketName}.s3.amazonaws.com/${imageKey}`;
        updateExpressionParts.push('#imageUrl = :imageUrl');
        expressionAttributeNames['#imageUrl'] = 'imageUrl';
        expressionAttributeValues[':imageUrl'] = imageUrl;
      } catch (error) {
        console.error('Error subiendo imagen a S3:', error);
        throw new HttpException(
          `Error al subir la imagen a S3: ${error.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }

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
      return { ...result.Attributes, image: undefined };
    } catch (error) {
      console.error('Error actualizando evento en DynamoDB:', error);
      throw new HttpException(
        'Error al actualizar evento en DynamoDB',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async delete(id: string) {
    const batchParams = {
      TableName: this.batchesTableName,
      KeyConditionExpression: 'eventId = :eventId',
      ExpressionAttributeValues: {
        ':eventId': id,
      },
    };

    try {
      const batchResult = await this.docClient.send(new QueryCommand(batchParams));
      const batches = batchResult.Items || [];

      for (const batch of batches) {
        const deleteBatchParams = {
          TableName: this.batchesTableName,
          Key: { eventId: id, batchId: batch.batchId },
        };
        await this.docClient.send(new DeleteCommand(deleteBatchParams));
      }

      const eventParams = {
        TableName: this.tableName,
        Key: { id },
      };
      await this.docClient.send(new DeleteCommand(eventParams));

      return { message: `Evento ${id} y sus tandas asociadas eliminados` };
    } catch (error) {
      throw new HttpException(
        'Error al eliminar evento y sus tandas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}