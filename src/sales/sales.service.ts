import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
  PutCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { CreateSaleDto } from './dto/create-sale.dto';
import { v4 as uuidv4 } from 'uuid';
import { EventsService } from '../events/events.service';
import { BatchesService } from '../batches/batches.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from '../payments/payments.service';
import { Readable } from 'stream';

@Injectable()
export class SalesService {
  private readonly tableName = 'Sales-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly sesClient: SESClient;
  private readonly s3Client: S3Client;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private readonly eventsService: EventsService,
    private readonly batchesService: BatchesService,
    private readonly ticketsService: TicketsService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
    this.sesClient = new SESClient({
      region: this.configService.get<string>('AWS_REGION'),
    });
    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION'),
    });
  }

  async createSale(
    createSaleDto: CreateSaleDto,
    userId: string,
    email: string,
    resellerId?: string,
    resellerEmail?: string,
  ) {
    const saleId = uuidv4();
    const { eventId, batchId, quantity, type } = createSaleDto;
    const event = await this.eventsService.findOne(eventId);
    if (!event) {
      throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
    }
    const batch = await this.batchesService.findOne(eventId, batchId);
    if (!batch || batch.availableTickets < quantity) {
      throw new HttpException(
        'No hay suficientes tickets en la tanda',
        HttpStatus.BAD_REQUEST,
      );
    }
    const basePrice = batch.price || 10;
    let total = quantity * basePrice;
    let commission = 0;
    if (type === 'reseller') {
      if (!resellerId || !resellerEmail) {
        throw new HttpException(
          'Se requiere resellerId y resellerEmail para ventas por revendedor',
          HttpStatus.BAD_REQUEST,
        );
      }
      commission = total * 0.1;
      total += commission;
    }
    const params: PutCommandInput = {
      TableName: this.tableName,
      Item: {
        id: saleId,
        userId,
        resellerId: resellerId || null,
        eventId,
        batchId,
        quantity,
        type,
        basePrice,
        commission,
        total,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    };
    try {
      await this.docClient.send(new PutCommand(params));
      await this.usersService.createOrUpdateUser(userId, 'User', email);
      if (resellerId && resellerEmail) {
        await this.usersService.createOrUpdateUser(
          resellerId,
          'Reseller',
          resellerEmail,
        );
      }
      return {
        id: saleId,
        eventId,
        batchId,
        quantity,
        type,
        basePrice,
        commission,
        total,
        status: 'pending',
      };
    } catch (error) {
      throw new HttpException(
        'Error al registrar la venta',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async confirmSale(saleId: string, paymentStatus: string, paymentId: string) {
    const sale = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { id: saleId },
      }),
    );
    if (!sale.Item) {
      throw new HttpException('Venta no encontrada', HttpStatus.NOT_FOUND);
    }
    if (sale.Item.status !== 'pending') {
      throw new HttpException('Venta ya procesada', HttpStatus.BAD_REQUEST);
    }
    const updateParams: UpdateCommandInput = {
      TableName: this.tableName,
      Key: { id: saleId },
      UpdateExpression:
        'SET #status = :status, #paymentId = :paymentId, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#paymentId': 'paymentId',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':status': paymentStatus,
        ':paymentId': paymentId,
        ':updatedAt': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW' as const,
    };
    try {
      console.log('Updating sale status:', { saleId, paymentStatus });
      const result = await this.docClient.send(new UpdateCommand(updateParams));
      if (paymentStatus === 'approved') {
        console.log('Decrementing tickets:', { eventId: sale.Item.eventId, batchId: sale.Item.batchId });
        await this.batchesService.decrementTickets(
          sale.Item.eventId,
          sale.Item.batchId,
          sale.Item.quantity,
        );
        console.log('Creating tickets for sale:', saleId);
        const tickets = await this.ticketsService.createTickets({
          id: saleId,
          userId: sale.Item.userId,
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
          quantity: sale.Item.quantity,
        });
        const ticketIds = tickets.map((ticket) => ticket.ticketId);
        console.log('Updating user tickets:', { userId: sale.Item.userId, ticketIds });
        await this.usersService.updateUserTickets(
          sale.Item.userId,
          ticketIds,
          sale.Item.resellerId,
        );
        console.log('Fetching user profile:', sale.Item.userId);
        const user = await this.usersService.getUserProfile(sale.Item.userId);
        console.log('Fetching event:', sale.Item.eventId);
        const event = await this.eventsService.findOne(sale.Item.eventId);
        console.log('Fetching batch:', { eventId: sale.Item.eventId, batchId: sale.Item.batchId });
        const batch = await this.batchesService.findOne(
          sale.Item.eventId,
          sale.Item.batchId,
        );
        console.log('Preparing QR attachments:', ticketIds);
        const qrAttachments = await Promise.all(
          tickets.map(async (ticket, index) => {
            const qrKey = ticket.qrS3Url.split('.amazonaws.com/')[1];
            const s3Response = await this.s3Client.send(
              new GetObjectCommand({
                Bucket: this.configService.get<string>('S3_BUCKET') || 'ticket-qr-bucket-dev-v2',
                Key: qrKey,
              }),
            );
            const body = await new Promise<Buffer>((resolve, reject) => {
              const chunks: Buffer[] = [];
              (s3Response.Body as Readable).on('data', (chunk) => chunks.push(chunk));
              (s3Response.Body as Readable).on('end', () => resolve(Buffer.concat(chunks)));
              (s3Response.Body as Readable).on('error', reject);
            });
            return {
              ContentType: 'image/png',
              Filename: `ticket-${index + 1}-${ticket.ticketId}.png`,
              ContentID: `qr-${ticket.ticketId}`,
              Content: body,
            };
          }),
        );
        console.log('Preparing email body');
        const emailBody = `
Hola ${user.alias || 'Usuario'},

Tu compra ha sido confirmada exitosamente.

**Comprobante de Pago**
- Venta ID: ${saleId}
- Evento: ${event?.name || 'Desconocido'}
- Tanda: ${batch?.name || 'Desconocida'}
- Cantidad de tickets: ${sale.Item.quantity}
- Precio por ticket: $${sale.Item.basePrice}
- Comisión: $${sale.Item.commission}
- Importe total abonado: $${sale.Item.total}
- Tickets: ${ticketIds.join(', ')}

**Códigos QR Únicos**
Los códigos QR de tus tickets están adjuntos en este correo.

¡Gracias por tu compra!
Equipo Groove Tickets
        `;
        const rawEmail = [
          `From: ${this.configService.get<string>('SES_EMAIL') || 'alexis@laikad.com'}`,
          `To: ${user.email}`,
          `Subject: Confirmación de Compra - ${event?.name || 'Evento'}`,
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="boundary"',
          '',
          '--boundary',
          'Content-Type: text/plain; charset=UTF-8',
          '',
          emailBody,
          ...qrAttachments.map((attachment) => [
            '--boundary',
            `Content-Type: ${attachment.ContentType}`,
            `Content-Disposition: attachment; filename="${attachment.Filename}"`,
            `Content-Transfer-Encoding: base64`,
            `Content-ID: <${attachment.ContentID}>`,
            '',
            attachment.Content.toString('base64'),
          ].join('\n')),
          '--boundary--',
        ].join('\n');
        console.log('Sending email to:', user.email);
        const emailParams = {
          RawMessage: {
            Data: Buffer.from(rawEmail),
          },
        };
        await this.sesClient.send(new SendRawEmailCommand(emailParams));
        console.log('Email sent successfully');
        return { ...result.Attributes, tickets };
      }
      return result.Attributes;
    } catch (error) {
      console.error('Error in confirmSale:', error);
      throw new HttpException(
        `Error al confirmar la venta: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async handleWebhook(paymentId: string) {
    const payment = await this.paymentsService.getPaymentStatus(paymentId);
    const status = payment.status;
    const saleId = payment.external_reference;

    if (!saleId) {
      throw new HttpException('No se encontró referencia de venta', HttpStatus.BAD_REQUEST);
    }

    await this.confirmSale(saleId, status, paymentId);

    return { status: 'processed', saleId, paymentStatus: status };
  }
}