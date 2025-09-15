import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { nanoid } from 'nanoid';
import * as QRCode from 'qrcode';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class TicketsService {
  private readonly tableName = 'Tickets-v2';
  private readonly scansTableName = 'TicketScans-v2';
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
    const tickets: Array<{
      ticketId: string;
      saleId: string;
      qrS3Url: string;
    }> = [];
    const bucket =
      this.configService.get<string>('S3_BUCKET') || 'ticket-qr-bucket-dev-v2';
    for (let i = 0; i < sale.quantity; i++) {
      const ticketId = nanoid(6);
      const qrData = `ticketId:${ticketId}`;
      const qrImageBuffer = await QRCode.toBuffer(qrData, { type: 'png' });
      const qrKey = `qrs/ticket-${ticketId}-${uuidv4()}.png`;
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: qrKey,
          Body: qrImageBuffer,
          ContentType: 'image/png',
        }),
      );
      const qrS3Url = `https://${bucket}.s3.amazonaws.com/${qrKey}`;
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

  async scanTickets(ticketIds: string[]) {
    const results: Array<{
      ticketId: string;
      status: 'valid' | 'invalid';
      message: string;
      ticket?: any;
    }> = [];
    const scanRecords: Array<{
      id: string;
      ticketId: string;
      status: string;
      scannedAt: string;
    }> = [];

    for (const ticketId of ticketIds) {
      try {
        const ticket = await this.validateTicket(ticketId);
        await this.docClient.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { id: ticketId },
            UpdateExpression: 'SET #status = :status, #usedAt = :usedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#usedAt': 'usedAt',
            },
            ExpressionAttributeValues: {
              ':status': 'used',
              ':usedAt': new Date().toISOString(),
            },
          }),
        );
        const scanId = nanoid(10);
        scanRecords.push({
          id: scanId,
          ticketId,
          status: 'valid',
          scannedAt: new Date().toISOString(),
        });
        results.push({
          ticketId,
          status: 'valid',
          message: 'Ticket válido y marcado como usado',
          ticket: {
            ticketId: ticket.id,
            saleId: ticket.saleId,
            userId: ticket.userId,
            eventId: ticket.eventId,
            batchId: ticket.batchId,
            status: 'used',
            qrS3Url: ticket.qrS3Url,
          },
        });
      } catch (error) {
        const scanId = nanoid(10);
        scanRecords.push({
          id: scanId,
          ticketId,
          status: 'invalid',
          scannedAt: new Date().toISOString(),
        });
        results.push({
          ticketId,
          status: 'invalid',
          message: error.message || 'Ticket no válido o inactivo',
        });
      }
    }

    for (const scan of scanRecords) {
      await this.docClient.send(
        new PutCommand({
          TableName: this.scansTableName,
          Item: scan,
        }),
      );
    }

    return results;
  }
}
