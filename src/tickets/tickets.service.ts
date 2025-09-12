import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { nanoid } from 'nanoid';
import * as QRCode from 'qrcode';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class TicketsService {
  private readonly tableName = 'Tickets-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly s3Client: S3Client;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private configService: ConfigService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION'),
    });
  }

  async createTickets(sale: {
    id: string;
    userId: string;
    eventId: string;
    batchId: string;
    quantity: number;
  }) {
    const tickets: Array<{ ticketId: string; saleId: string; qrS3Url: string }> = [];
    for (let i = 0; i < sale.quantity; i++) {
      const ticketId = nanoid(6);
      const qrData = `ticketId:${ticketId}`; // Codifica solo ticketId por seguridad
      const qrImageBase64 = await QRCode.toDataURL(qrData);
      const qrKey = `tickets-qr/${ticketId}-${uuidv4()}.png`;
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.configService.get<string>('S3_BUCKET') || 'ticket-qr-bucket-dev-v2',
          Key: qrKey,
          Body: Buffer.from(qrImageBase64.split(',')[1], 'base64'),
          ContentType: 'image/png',
        }),
      );
      const qrS3Url = `https://${this.configService.get<string>('S3_BUCKET')}.s3.amazonaws.com/${qrKey}`;
      const params = {
        TableName: this.tableName,
        Item: {
          id: ticketId,
          saleId: sale.id,
          userId: sale.userId,
          eventId: sale.eventId,
          batchId: sale.batchId,
          status: 'active',
          qrS3Url,
          createdAt: new Date().toISOString(),
        },
      };
      await this.docClient.send(new PutCommand(params));
      tickets.push({ ticketId, saleId: sale.id, qrS3Url });
    }
    return tickets;
  }

  async validateTicket(ticketId: string) {
    const params = {
      TableName: this.tableName,
      Key: { id: ticketId },
    };
    try {
      const result = await this.docClient.send(new GetCommand(params));
      if (!result.Item || result.Item.status !== 'active') {
        throw new HttpException(
          'Ticket no válido o inactivo',
          HttpStatus.BAD_REQUEST,
        );
      }
      return result.Item;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al validar ticket',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}