import {
  Injectable,
  Inject,
  HttpException,
  HttpStatus,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
  PutCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { CreateSaleDto } from './dto/create-sale.dto';
import { GeneratePaymentDto } from './dto/generate-payment.dto';
import { v4 as uuidv4 } from 'uuid';
import { EventsService } from '../events/events.service';
import { BatchesService } from '../batches/batches.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import * as QRCode from 'qrcode';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class SalesService {
  private readonly tableName = 'Sales-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly sesClient: SESClient;
  private readonly mpClient: MercadoPagoConfig;
  private readonly s3Client: S3Client;
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private readonly eventsService: EventsService,
    private readonly batchesService: BatchesService,
    private readonly ticketsService: TicketsService,
    @Inject(forwardRef(() => UsersService)) private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
    this.sesClient = new SESClient({
      region: this.configService.get<string>('AWS_REGION'),
    });
    this.mpClient = new MercadoPagoConfig({
      accessToken: 'APP_USR-8581189409054279-091018-c6d03928f1a9466fb3fbc1cdbcf80512-2369426390',
    });
    this.s3Client = new S3Client({ region: this.configService.get<string>('AWS_REGION') });
  }

  private validateId(id: string, fieldName: string = 'ID'): void {
    if (!id || id.trim() === '') {
      throw new HttpException(`El ${fieldName} no puede estar vacío`, HttpStatus.BAD_REQUEST);
    }
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(id)) {
      throw new HttpException(`El ${fieldName} no tiene un formato válido (debe ser un UUID)`, HttpStatus.BAD_REQUEST);
    }
  }

  private validateNumber(value: number, fieldName: string, allowZero: boolean = false): void {
    if (typeof value !== 'number' || (allowZero ? value < 0 : value <= 0)) {
      throw new HttpException(`El ${fieldName} debe ser un número ${allowZero ? 'no negativo' : 'positivo'}`, HttpStatus.BAD_REQUEST);
    }
  }

  async createSale(
    createSaleDto: CreateSaleDto,
    userId: string,
    email: string,
    resellerId?: string,
    resellerEmail?: string,
  ) {
    this.validateId(userId, 'userId');
    const saleId = uuidv4();
    const { eventId, batchId, quantity, type } = createSaleDto;
    this.validateId(eventId, 'eventId');
    this.validateId(batchId, 'batchId');
    this.validateNumber(quantity, 'quantity');

    // Validar evento
    const event = await this.eventsService.findOne(eventId);
    if (!event) {
      throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
    }
    // Validar tanda y precio
    const batch = await this.batchesService.findOne(eventId, batchId);
    if (!batch || batch.availableTickets < quantity) {
      throw new HttpException('No hay suficientes tickets en la tanda', HttpStatus.BAD_REQUEST);
    }
    // Calcular precio y comisión
    const basePrice = batch.price || 10;
    let total = quantity * basePrice;
    let commission = 0;
    if (type === 'reseller') {
      if (!resellerId || !resellerEmail) {
        throw new HttpException('Se requiere resellerId y resellerEmail para ventas por revendedor', HttpStatus.BAD_REQUEST);
      }
      this.validateId(resellerId, 'resellerId');
      commission = total * 0.1;
      total += commission;
    }
    // Registrar venta como pending
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
      // Crear perfil de usuario si no existe
      await this.usersService.createOrUpdateUser(userId, 'User', email);
      if (resellerId && resellerEmail) {
        await this.usersService.createOrUpdateUser(resellerId, 'Reseller', resellerEmail);
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
      throw new HttpException('Error al registrar la venta en DynamoDB', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async generatePaymentLink(saleId: string, amount: number, title: string): Promise<string> {
    this.validateId(saleId, 'saleId');
    this.validateNumber(amount, 'amount', true);

    const preference = new Preference(this.mpClient);
    const apiBaseUrl = this.configService.get<string>('API_BASE_URL');
    const defaultUrl = 'https://tu-dominio.com'; // Fallback público
    const baseUrl = apiBaseUrl && apiBaseUrl.match(/^https?:\/\/[^\s/$.?#].[^\s]*$/) ? apiBaseUrl : defaultUrl;

    const preferenceData = {
      items: [
        {
          id: saleId,
          title: title,
          unit_price: amount,
          quantity: 1,
          currency_id: 'ARS',
        },
      ],
      back_urls: {
        success: `${baseUrl}/payments/success`,
        failure: `${baseUrl}/payments/failure`,
        pending: `${baseUrl}/payments/pending`,
      },
      auto_return: 'approved',
      external_reference: saleId,
      notification_url: `${baseUrl}/sales/webhook`,
    };

    try {
      const response = await preference.create({ body: preferenceData });
      return response.init_point || '';
    } catch (error) {
      throw new HttpException(`Error al generar link de pago con MercadoPago: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async generatePaymentForUser(dto: GeneratePaymentDto, resellerId: string, resellerEmail: string) {
    this.validateId(resellerId, 'resellerId');
    const { eventId, batchId, quantity, userAlias, userEmail } = dto;

    if (!userAlias && !userEmail) {
      throw new HttpException('Se requiere userAlias o userEmail', HttpStatus.BAD_REQUEST);
    }

    // Buscar usuario por alias o email
    let user;
    if (userAlias) {
      user = await this.usersService.findUserByAlias(userAlias);
    } else if (userEmail) {
      const users = await this.usersService.getAllUsers();
      user = users.find(u => u.email === userEmail);
    }
    if (!user) {
      throw new HttpException('Usuario no encontrado', HttpStatus.NOT_FOUND);
    }
    this.validateId(user.id, 'userId');

    // Crear venta
    const createSaleDto: CreateSaleDto = {
      eventId,
      batchId,
      quantity,
      type: 'reseller',
    };
    const sale = await this.createSale(createSaleDto, user.id, user.email, resellerId, resellerEmail);

    // Enviar email al usuario con el paymentLink
    const event = await this.eventsService.findOne(eventId);
    const batch = await this.batchesService.findOne(eventId, batchId);
    const paymentLink = await this.generatePaymentLink(sale.id, sale.total, `Compra de ${quantity} ticket(s) para evento ${eventId} (Revendedor)`);
    const emailParams = {
      Source: this.configService.get<string>('SES_EMAIL') || 'tu-email@dominio.com',
      Destination: {
        ToAddresses: [user.email],
      },
      Message: {
        Subject: {
          Data: `Link de Pago para tu Compra - ${event?.name || 'Evento'}`,
        },
        Body: {
          Text: {
            Data: `Hola,\n\nUn revendedor ha generado un link de pago para tu compra:\n\n- Evento: ${event?.name || 'Desconocido'}\n- Tanda: ${batch?.name || 'Desconocida'}\n- Cantidad: ${quantity}\n- Total: $${sale.total}\n- Link de Pago: ${paymentLink}\n\nUsa el link para completar el pago en MercadoPago.\n\n¡Gracias!\nEquipo Groove Tickets`,
          },
        },
      },
    };

    try {
      await this.sesClient.send(new SendEmailCommand(emailParams));
      return {
        saleId: sale.id,
        paymentLink,
      };
    } catch (error) {
      throw new HttpException('Error al enviar email de pago a SES', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async confirmSale(saleId: string, paymentStatus: string, paymentId: string) {
    this.validateId(saleId, 'saleId');
    this.logger.debug(`Starting confirmation for saleId: ${saleId}, paymentStatus: ${paymentStatus}, paymentId: ${paymentId}`);
    const sale = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { id: saleId },
      }),
    );
    if (!sale.Item) {
      this.logger.error(`Sale not found in DynamoDB for saleId: ${saleId}`);
      throw new HttpException(`Venta con ID ${saleId} no encontrada en DynamoDB`, HttpStatus.NOT_FOUND);
    }
    if (sale.Item.status !== 'pending') {
      this.logger.warn(`Sale already processed for saleId: ${saleId}, current status: ${sale.Item.status}`);
      throw new HttpException(`Venta con ID ${saleId} ya procesada, estado: ${sale.Item.status}`, HttpStatus.BAD_REQUEST);
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
      const result = await this.docClient.send(new UpdateCommand(updateParams));
      this.logger.debug(`Sale status updated successfully for saleId: ${saleId}`);
      if (paymentStatus === 'approved') {
        this.logger.debug(`Processing approved payment for saleId: ${saleId}`);
        // Restar tickets
        try {
          await this.batchesService.decrementTickets(
            sale.Item.eventId,
            sale.Item.batchId,
            sale.Item.quantity,
          );
          this.logger.debug(`Tickets decremented successfully for batchId: ${sale.Item.batchId}`);
        } catch (batchError) {
          this.logger.error(`Failed to decrement tickets for batchId ${sale.Item.batchId}: ${batchError.message}`);
          throw new HttpException(`Error al restar tickets de la tanda ${sale.Item.batchId}: ${batchError.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
        }
        // Generar tickets individuales
        let tickets;
        try {
          tickets = await this.ticketsService.createTickets({
            id: saleId,
            userId: sale.Item.userId,
            eventId: sale.Item.eventId,
            batchId: sale.Item.batchId,
            quantity: sale.Item.quantity,
          });
          this.logger.debug(`Tickets created successfully: ${JSON.stringify(tickets)}`);
        } catch (ticketError) {
          this.logger.error(`Failed to create tickets for saleId ${saleId}: ${ticketError.message}`);
          throw new HttpException(`Error al crear tickets para la venta ${saleId}: ${ticketError.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
        }
        // Actualizar perfil de usuario y revendedor
        const ticketIds = tickets.map((ticket) => ticket.ticketId);
        try {
          await this.usersService.updateUserTickets(
            sale.Item.userId,
            ticketIds,
            sale.Item.resellerId,
          );
          this.logger.debug(`User profile updated with ticketIds: ${ticketIds}`);
        } catch (userError) {
          this.logger.error(`Failed to update user profile for userId ${sale.Item.userId}: ${userError.message}`);
          throw new HttpException(`Error al actualizar el perfil del usuario ${sale.Item.userId}: ${userError.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
        }

        // Generar QR único por ticketId y subir a S3
        const qrUrls: { [key: string]: string } = {};
        for (const ticket of tickets) {
          const qrData = `ticket:${ticket.ticketId}`;
          try {
            const qrImageBase64 = await QRCode.toDataURL(qrData, {
              errorCorrectionLevel: 'H',
              margin: 2,
              width: 300,
            });
            const qrKey = `qrs/ticket-${ticket.ticketId}-${uuidv4()}.png`;
            const s3Params = {
              Bucket: this.configService.get<string>('S3_BUCKET') || 'ticket-qr-bucket-dev-v2',
              Key: qrKey,
              Body: Buffer.from(qrImageBase64.split(',')[1], 'base64'),
              ContentType: 'image/png',
            };
            await this.s3Client.send(new PutObjectCommand(s3Params));
            qrUrls[ticket.ticketId] = `https://${this.configService.get<string>('S3_BUCKET') || 'ticket-qr-bucket-dev-v2'}.s3.amazonaws.com/${qrKey}`;
            this.logger.debug(`QR uploaded successfully for ticketId: ${ticket.ticketId}`);
          } catch (s3Error) {
            this.logger.error(`Failed to upload QR for ticket ${ticket.ticketId}: ${s3Error.message}`);
            throw new HttpException(`Error al subir QR para ticket ${ticket.ticketId} a S3: ${s3Error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
          }
        }

        // Obtener email del usuario
        let user;
        try {
          user = await this.usersService.getUserProfile(sale.Item.userId);
          this.logger.debug(`User profile retrieved for userId: ${sale.Item.userId}`);
        } catch (userError) {
          this.logger.error(`Failed to retrieve user profile for userId ${sale.Item.userId}: ${userError.message}`);
          throw new HttpException(`Error al obtener el perfil del usuario ${sale.Item.userId}: ${userError.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
        }
        const event = await this.eventsService.findOne(sale.Item.eventId);
        const batch = await this.batchesService.findOne(sale.Item.eventId, sale.Item.batchId);

        // Enviar email de confirmación con QR
        try {
          const emailParams = {
            Source: this.configService.get<string>('SES_EMAIL') || 'tu-email@dominio.com',
            Destination: {
              ToAddresses: [user.email],
            },
            Message: {
              Subject: {
                Data: `Confirmación de Compra - ${event?.name || 'Evento'}`,
              },
              Body: {
                Text: {
                  Data: `Hola,\n\nTu compra ha sido confirmada exitosamente.\n\nDetalles de la compra:\n- Venta ID: ${saleId}\n- Evento: ${event?.name || 'Desconocido'}\n- Tanda: ${batch?.name || 'Desconocida'}\n- Cantidad: ${sale.Item.quantity}\n- Total: $${sale.Item.total}\n- Tickets: ${ticketIds.join(', ')}\n- QR para validación: ${Object.entries(qrUrls).map(([ticketId, url]) => `${ticketId}: ${url}`).join('\n')}\n\nPresenta el QR en el evento para validación.\n¡Gracias por tu compra!\nEquipo Groove Tickets`,
                },
              },
            },
          };
          //await this.sesClient.send(new SendEmailCommand(emailParams));
          //this.logger.debug(`Confirmation email sent successfully for saleId: ${saleId}`);
        } catch (emailError) {
          this.logger.error(`Failed to send confirmation email for saleId ${saleId}: ${emailError.message}`);
          throw new HttpException(`Error al enviar email de confirmación para la venta ${saleId}: ${emailError.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
        }
        return { ...result.Attributes, tickets, qrUrls };
      }
      return result.Attributes;
    } catch (error) {
      this.logger.error(`Unexpected error in confirmSale for saleId ${saleId}: ${error.message}`, error.stack);
      throw new HttpException(`Error al confirmar la venta ${saleId}: Detalle - ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}