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
  ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { SearchEventDto } from './dto/search.dto';
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
    
    // Configurar S3Client con la misma lógica que DynamoDBClient
    const region = this.configService.get<string>('AWS_REGION') || 'us-east-1';
    const endpoint = this.configService.get<string>('AWS_ENDPOINT_URL');
    
    const s3Config: any = {
      region,
    };
    
    // Solo usar LocalStack si hay endpoint URL explícitamente configurado
    if (endpoint && endpoint.includes('localhost:4566')) {
      s3Config.endpoint = endpoint;
      s3Config.credentials = {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      };
    } else {
      // Usar credenciales desde variables de entorno
      const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
      const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
      
      if (accessKeyId && secretAccessKey) {
        s3Config.credentials = {
          accessKeyId,
          secretAccessKey,
        };
      }
      // Si no hay credenciales explícitas, AWS SDK usará las credenciales por defecto
    }
    
    this.s3Client = new S3Client(s3Config);
    this.bucketName =
      this.configService.get<string>('S3_BUCKET') || 'ticket-qr-bucket-dev-v2';
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
        name: createEventDto.name.trim(), // Normalizar al crear
        from: createEventDto.from,
        to: createEventDto.to,
        location: createEventDto.location
          ? createEventDto.location.trim()
          : undefined,
        description: createEventDto.description
          ? createEventDto.description.trim()
          : undefined,
        imageUrl,
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
      console.error('Error en findAll eventos:', error);
      console.error('Error details:', {
        message: error?.message,
        name: error?.name,
        code: error?.code,
        tableName: this.tableName,
      });
      throw new HttpException(
        `Error al obtener eventos: ${error?.message || 'Error desconocido'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async search(query: SearchEventDto) {
    const params: ScanCommandInput = {
      TableName: this.tableName,
      FilterExpression: '',
      ExpressionAttributeNames: {},
      ExpressionAttributeValues: {},
    };

    const filterExpressions: string[] = [];

    // Normalizar entradas: eliminar espacios múltiples, acentos y convertir a minúsculas
    const normalize = (str: string | undefined) => {
      if (!str) return undefined;
      return str
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ') // Normalizar espacios
        .normalize('NFD') // Descomponer acentos
        .replace(/[\u0300-\u036f]/g, ''); // Eliminar marcas de acentos
    };

    const normalizedQ = normalize(query.q);
    const normalizedName = normalize(query.name);
    const normalizedLocation = normalize(query.location);
    const normalizedDescription = normalize(query.description);
    const from = query.from;
    const to = query.to;

    if (normalizedQ) {
      filterExpressions.push(
        '(contains(#name, :q) OR contains(#location, :q) OR contains(#description, :q))',
      );
      params.ExpressionAttributeNames!['#name'] = 'name';
      params.ExpressionAttributeNames!['#location'] = 'location';
      params.ExpressionAttributeNames!['#description'] = 'description';
      params.ExpressionAttributeValues![':q'] = normalizedQ;
    }

    if (normalizedName) {
      filterExpressions.push('contains(#name, :name)');
      params.ExpressionAttributeNames!['#name'] = 'name';
      params.ExpressionAttributeValues![':name'] = normalizedName;
    }

    if (normalizedLocation) {
      filterExpressions.push('contains(#location, :location)');
      params.ExpressionAttributeNames!['#location'] = 'location';
      params.ExpressionAttributeValues![':location'] = normalizedLocation;
    }

    if (normalizedDescription) {
      filterExpressions.push('contains(#description, :description)');
      params.ExpressionAttributeNames!['#description'] = 'description';
      params.ExpressionAttributeValues![':description'] = normalizedDescription;
    }

    if (from) {
      filterExpressions.push('#from >= :from');
      params.ExpressionAttributeNames!['#from'] = 'from';
      params.ExpressionAttributeValues![':from'] = from;
    }

    if (to) {
      filterExpressions.push('#to <= :to');
      params.ExpressionAttributeNames!['#to'] = 'to';
      params.ExpressionAttributeValues![':to'] = to;
    }

    if (filterExpressions.length > 0) {
      params.FilterExpression = filterExpressions.join(' AND ');
    }

    try {
      const result = await this.docClient.send(new ScanCommand(params));
      return result.Items || [];
    } catch (error) {
      console.error('Error al buscar eventos:', error);
      throw new HttpException(
        'Error al buscar eventos',
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
      expressionAttributeValues[':name'] = updateEventDto.name.trim();
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
      expressionAttributeValues[':location'] = updateEventDto.location.trim();
    }
    if (updateEventDto.description !== undefined) {
      updateExpressionParts.push('#description = :description');
      expressionAttributeNames['#description'] = 'description';
      expressionAttributeValues[':description'] = updateEventDto.description
        ? updateEventDto.description.trim()
        : undefined;
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

  async debug() {
    const params = {
      TableName: this.tableName,
    };
    try {
      const result = await this.docClient.send(new ScanCommand(params));
      return result.Items || [];
    } catch (error) {
      throw new HttpException(
        'Error al obtener datos crudos de eventos',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
