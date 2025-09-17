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
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { CreateSaleDto } from './dto/create-sale.dto';
import { v4 as uuidv4 } from 'uuid';
import { EventsService } from '../events/events.service';
import { BatchesService } from '../batches/batches.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from '../payments/payments.service';
import { EmailService } from '../email/email.service';
import { Readable } from 'stream';

@Injectable()
export class SalesService {
  private readonly tableName = 'Sales-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly s3Client: S3Client;
  private readonly DIRECT_SALE_FEE = 1; // Costo fijo por ticket en compras directas

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private readonly eventsService: EventsService,
    private readonly batchesService: BatchesService,
    private readonly ticketsService: TicketsService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
    private readonly emailService: EmailService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
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
    const {
      eventId,
      batchId,
      quantity,
      type,
      buyerEmailOrAlias,
      resellerId: providedResellerId,
    } = createSaleDto;
    let finalUserId = userId;
    let finalEmail = email;
    // Para ventas reseller, validar buyerEmailOrAlias si se proporciona
    if (type === 'reseller' && buyerEmailOrAlias) {
      const user =
        await this.usersService.getUserByEmailOrAlias(buyerEmailOrAlias);
      if (!user) {
        throw new HttpException(
          'El email o alias del comprador no está registrado',
          HttpStatus.BAD_REQUEST,
        );
      }
      finalUserId = user.id;
      finalEmail = user.email;
    }
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
    // Agregar costo fijo de 2000 por ticket en compras directas
    if (type === 'direct') {
      total += quantity * this.DIRECT_SALE_FEE;
    }
    // Calcular comisión para ventas por revendedor
    if (type === 'reseller') {
      const finalResellerId = resellerId || providedResellerId;
      if (!finalResellerId) {
        throw new HttpException(
          'Se requiere resellerId para ventas por revendedor',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    const params: PutCommandInput = {
      TableName: this.tableName,
      Item: {
        id: saleId,
        userId: finalUserId,
        resellerId:
          type === 'reseller' ? resellerId || providedResellerId : null,
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
      await this.usersService.createOrUpdateUser(
        finalUserId,
        'User',
        finalEmail,
      );
      if (type === 'reseller' && (resellerId || providedResellerId)) {
        await this.usersService.createOrUpdateUser(
          resellerId || providedResellerId!,
          'Reseller',
          resellerEmail || finalEmail,
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
    console.log("entro a confirmSale con saleId:", saleId, "y paymentStatus:", paymentStatus); // Log para debug
    const sale = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { id: saleId },
      }),
    );
    console.log("paso sale: ", sale); // Log para debug
    if (!sale.Item) {
      throw new HttpException('Venta no encontrada', HttpStatus.NOT_FOUND);
    }

    if (sale.Item.status !== 'pending') {
      throw new HttpException('Venta ya procesada', HttpStatus.BAD_REQUEST);
    }
    console.log("esta por entrar en updateParams");
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
    console.log("paso updateParams");
    console.log("updateParams preparados:", updateParams); // Log para debug
    try {
      console.log('Updating sale status:', { saleId, paymentStatus });
      const result = await this.docClient.send(new UpdateCommand(updateParams));
      console.log("resultado de updateCommand:", result); // Log para debug
      if (paymentStatus === 'approved') {
        console.log('Decrementing tickets:', {
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
        });
        console.log("decremento de cantidad de ticket")
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
        console.log("tickets creados:", tickets); // Log para debug
        const ticketIds = tickets.map((ticket) => ticket.ticketId);
        console.log('Updating user tickets:', {
          userId: sale.Item.userId,
          ticketIds,
        });
        console.log("actualizo tickets del usuario")
        await this.usersService.updateUserTickets(
          sale.Item.userId,
          ticketIds,
          sale.Item.resellerId,
        );
        console.log('Fetching user profile:', sale.Item.userId);
        const user = await this.usersService.getUserProfile(sale.Item.userId);
        console.log('Fetching event:', sale.Item.eventId);
        const event = await this.eventsService.findOne(sale.Item.eventId);
        console.log('Fetching batch:', {
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
        });

        const batch = await this.batchesService.findOne(
          sale.Item.eventId,
          sale.Item.batchId,
        );
        console.log('Preparing email with QR codes');

        const qrAttachments = await Promise.all(
          tickets.map(async (ticket, index) => {
            try {
              const qrKey = ticket.qrS3Url
                .split('.amazonaws.com/')[1]
                .replace(/^\/+/, ''); // Remove leading slashes
              const s3Response = await this.s3Client.send(
                new GetObjectCommand({
                  Bucket:
                    this.configService.get<string>('S3_BUCKET') ||
                    'ticket-qr-bucket-dev-v2',
                  Key: qrKey,
                }),
              );

              // Ensure the S3 response body exists
              if (!s3Response.Body) {
                throw new Error(
                  `No body returned for QR code with key: ${qrKey}`,
                );
              }

              // Convert the S3 response body to a Buffer
              const body = await s3Response.Body.transformToByteArray();
              const buffer = Buffer.from(body);

              return {
                content: buffer.toString('base64'),
                filename: `ticket-${index + 1}-${ticket.ticketId}.png`,
                type: 'image/png',
                disposition: 'attachment',
                contentId: `qr-${ticket.ticketId}`,
              };
            } catch (error) {
              console.error(
                `Error fetching QR code for ticket ${ticket.ticketId}:`,
                error,
              );
              throw new HttpException(
                `Failed to fetch QR code for ticket ${ticket.ticketId}: ${error.message}`,
                HttpStatus.INTERNAL_SERVER_ERROR,
              );
            }
          }),
        );
        console.log('QR attachments prepared:', qrAttachments.length);

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
        console.log('Sending email to:', user.email);
        await this.emailService.sendConfirmationEmail(
          user.email,
          `Confirmación de Compra - ${event?.name || 'Evento'}`,
          emailBody,
          qrAttachments,
        );
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
    console.log("handleWebhook llamado con paymentId:", paymentId, "status:", status, "saleId:", saleId); // Log para debug
    if (!saleId) {
      console.log("entro a saleId no encontrado");
      throw new HttpException(
        'No se encontró referencia de venta',
        HttpStatus.BAD_REQUEST,
      );
    }
    console.log("no entro a saleId no encontrado, saleId es:", saleId);
    console.log("esta por entrar a confirmSale");
    await this.confirmSale(saleId, status, paymentId);
    return { status: 'processed', saleId, paymentStatus: status };
  }
}
