import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  PutCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { CreateSaleDto } from './dto/create-sale.dto';
import { v4 as uuidv4 } from 'uuid';
import { EventsService } from '../events/events.service';
import { BatchesService } from '../batches/batches.service';

@Injectable()
export class SalesService {
  private readonly tableName = 'Sales-v2';
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private readonly eventsService: EventsService,
    private readonly batchesService: BatchesService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
  }

  async createSale(createSaleDto: CreateSaleDto, userId: string) {
    const saleId = uuidv4();
    const { eventId, batchId, quantity } = createSaleDto;

    // Verificar disponibilidad y decrementar tickets
    const event = await this.eventsService.findOne(eventId);
    if (!event || event.availableTickets < quantity) {
      throw new HttpException(
        'No hay suficientes tickets disponibles',
        HttpStatus.BAD_REQUEST,
      );
    }

    const batches = await this.batchesService.findAll(eventId);
    const batch = batches?.find((b) => b.batchId === batchId);
    if (!batch || batch.availableTickets < quantity) {
      throw new HttpException(
        'No hay suficientes tickets en la tanda',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Decrementar tickets de manera atómica
    await this.eventsService.decrementTickets(eventId, quantity);
    await this.batchesService.decrementTickets(eventId, batchId, quantity);

    // Registrar la venta
    const total = quantity * 10; // Calcular total antes de enviar
    const params: PutCommandInput = {
      TableName: this.tableName,
      Item: {
        id: saleId,
        userId,
        eventId,
        batchId,
        quantity,
        total,
        createdAt: new Date().toISOString(),
      },
    };

    try {
      await this.docClient.send(new PutCommand(params));
      return { id: saleId, eventId, batchId, quantity, total };
    } catch (error) {
      throw new HttpException(
        'Error al registrar la venta',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
