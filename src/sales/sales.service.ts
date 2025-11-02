import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
  PutCommandInput,
  UpdateCommandInput,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CreateFreeSaleDto } from './dto/create-free-sale.dto';
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
  private readonly DIRECT_SALE_FEE = 2000;
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
    userRole?: string, // Agregar el rol del JWT
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

    // Validar que solo usuarios con rol Reseller puedan crear ventas de tipo reseller
    if (type === 'reseller') {
      // Usar el rol del JWT token en lugar del de DynamoDB para consistencia
      const roleToCheck = userRole || 'User';
      if (roleToCheck !== 'Reseller') {
        throw new HttpException(
          'Solo usuarios con rol Reseller pueden crear ventas de tipo reseller',
          HttpStatus.FORBIDDEN,
        );
      }
    }
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
      console.log('Venta creada:', { saleId, userId: finalUserId, type });
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
      console.error('Error al registrar la venta:', error);
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
      console.log('Actualizando estado de venta:', {
        saleId,
        paymentStatus,
        paymentId,
      });
      const result = await this.docClient.send(new UpdateCommand(updateParams));
      if (paymentStatus === 'approved') {
        console.log('Decrementando tickets:', {
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
          quantity: sale.Item.quantity,
        });
        await this.batchesService.decrementTickets(
          sale.Item.eventId,
          sale.Item.batchId,
          sale.Item.quantity,
        );
        console.log('Creando tickets para venta:', saleId);
        const tickets = await this.ticketsService.createTickets({
          id: saleId,
          userId: sale.Item.userId,
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
          quantity: sale.Item.quantity,
        });
        const ticketIds = tickets.map((ticket) => ticket.ticketId);
        console.log('Actualizando tickets de usuario:', {
          userId: sale.Item.userId,
          ticketIds,
          resellerId: sale.Item.resellerId,
        });
        await this.usersService.updateUserTickets(
          sale.Item.userId,
          ticketIds,
          sale.Item.resellerId,
        );
        console.log('Obteniendo perfil de usuario:', sale.Item.userId);
        const user = await this.usersService.getUserProfile(sale.Item.userId);
        console.log('Obteniendo evento:', sale.Item.eventId);
        const event = await this.eventsService.findOne(sale.Item.eventId);
        console.log('Obteniendo tanda:', {
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
        });
        const batch = await this.batchesService.findOne(
          sale.Item.eventId,
          sale.Item.batchId,
        );
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
              if (!s3Response.Body) {
                throw new Error(
                  `No body returned for QR code with key: ${qrKey}`,
                );
              }
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
        console.log('Enviando email a:', user.email);
        await this.emailService.sendConfirmationEmail(
          user.email,
          `Confirmación de Compra - ${event?.name || 'Evento'}`,
          emailBody,
          qrAttachments,
        );
        console.log('Email enviado exitosamente');
        return { ...result.Attributes, tickets };
      }
      return result.Attributes;
    } catch (error) {
      console.error('Error en confirmSale:', {
        saleId,
        paymentStatus,
        paymentId,
        error: error.message,
      });
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Error al confirmar la venta: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  async handleWebhook(paymentId: string) {
    try {
      const payment = await this.paymentsService.getPaymentStatus(paymentId);
      const status = payment.status;
      const saleId = payment.external_reference;
      if (!saleId) {
        throw new HttpException(
          'No se encontró referencia de venta',
          HttpStatus.BAD_REQUEST,
        );
      }
      console.log('Procesando webhook:', { paymentId, status, saleId });
      await this.confirmSale(saleId, status, paymentId);
      return { status: 'processed', saleId, paymentStatus: status };
    } catch (error) {
      console.error('Error en handleWebhook:', error);
      throw new HttpException(
        `Error al procesar webhook: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Obtiene el total de tickets gratis ya generados para un evento
   */
  async getFreeTicketsCount(eventId: string): Promise<number> {
    try {
      const result = await this.docClient.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'eventId = :eventId AND isFree = :isFree AND #status = :status',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':eventId': eventId,
            ':isFree': true,
            ':status': 'approved',
          },
        }),
      );
      const freeSales = result.Items || [];
      return freeSales.reduce((total, sale) => total + (sale.quantity || 0), 0);
    } catch (error) {
      console.error('Error al contar tickets gratis:', error);
      return 0;
    }
  }

  /**
   * Obtiene el total de tickets del evento (suma de todos los batches)
   */
  async getTotalEventTickets(eventId: string): Promise<number> {
    try {
      const batches = await this.batchesService.findAll(eventId);
      return batches.reduce((total, batch) => total + (batch.totalTickets || 0), 0);
    } catch (error) {
      console.error('Error al obtener total de tickets del evento:', error);
      return 0;
    }
  }

  /**
   * Crea una venta gratuita (QR gratis)
   */
  async createFreeSale(
    createFreeSaleDto: CreateFreeSaleDto,
    resellerId: string,
    resellerEmail: string,
  ) {
    const saleId = uuidv4();
    const { eventId, batchId, quantity, buyerEmailOrAlias } = createFreeSaleDto;

    // 1. Validar que el usuario comprador existe
    const buyer = await this.usersService.getUserByEmailOrAlias(buyerEmailOrAlias);
    if (!buyer) {
      throw new HttpException(
        'El email o alias del comprador no está registrado',
        HttpStatus.BAD_REQUEST,
      );
    }

    // 2. Validar evento y batch
    const event = await this.eventsService.findOne(eventId);
    if (!event) {
      throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
    }

    const batch = await this.batchesService.findOne(eventId, batchId);
    if (!batch || batch.availableTickets < quantity) {
      throw new HttpException(
        'No hay suficientes tickets disponibles en la tanda',
        HttpStatus.BAD_REQUEST,
      );
    }

    // 3. Validar límite del 25% de tickets gratis
    const totalEventTickets = await this.getTotalEventTickets(eventId);
    const freeTicketsCount = await this.getFreeTicketsCount(eventId);
    const maxFreeTickets = Math.floor(totalEventTickets * 0.25);
    const freeTicketsAfterThis = freeTicketsCount + quantity;

    if (freeTicketsAfterThis > maxFreeTickets) {
      throw new HttpException(
        `No se pueden generar más tickets gratis. Límite del 25% alcanzado (${freeTicketsCount}/${maxFreeTickets} tickets gratis ya generados). Puedes generar hasta ${maxFreeTickets - freeTicketsCount} tickets más.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // 4. Crear la venta con status 'approved' y isFree: true
    const basePrice = batch.price || 0;
    const params: PutCommandInput = {
      TableName: this.tableName,
      Item: {
        id: saleId,
        userId: buyer.id,
        resellerId: resellerId,
        eventId,
        batchId,
        quantity,
        type: 'reseller',
        basePrice,
        commission: 0,
        total: 0, // Total es 0 porque es gratis
        status: 'approved', // Aprobado inmediatamente (sin pago)
        isFree: true, // Marcar como gratis
        createdAt: new Date().toISOString(),
      },
    };

    try {
      await this.docClient.send(new PutCommand(params));
      
      // 5. Confirmar la venta gratis (genera tickets, envía email, etc.)
      await this.confirmFreeSale(saleId, resellerEmail);

      console.log('Venta gratis creada:', { saleId, buyerId: buyer.id, resellerId });
      return {
        id: saleId,
        eventId,
        batchId,
        quantity,
        type: 'reseller',
        basePrice,
        total: 0,
        status: 'approved',
        isFree: true,
      };
    } catch (error) {
      console.error('Error al registrar la venta gratis:', error);
      throw new HttpException(
        `Error al registrar la venta gratis: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Confirma una venta gratis (genera tickets, envía email especial)
   */
  async confirmFreeSale(saleId: string, resellerEmail: string) {
    const sale = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { id: saleId },
      }),
    );

    if (!sale.Item) {
      throw new HttpException('Venta no encontrada', HttpStatus.NOT_FOUND);
    }

    if (!sale.Item.isFree) {
      throw new HttpException('Esta venta no es gratuita', HttpStatus.BAD_REQUEST);
    }

    try {
      // 1. Decrementar tickets del batch
      console.log('Decrementando tickets para venta gratis:', {
        eventId: sale.Item.eventId,
        batchId: sale.Item.batchId,
        quantity: sale.Item.quantity,
      });
      await this.batchesService.decrementTickets(
        sale.Item.eventId,
        sale.Item.batchId,
        sale.Item.quantity,
      );

      // 2. Crear tickets
      console.log('Creando tickets para venta gratis:', saleId);
      const tickets = await this.ticketsService.createTickets({
        id: saleId,
        userId: sale.Item.userId,
        eventId: sale.Item.eventId,
        batchId: sale.Item.batchId,
        quantity: sale.Item.quantity,
      });

      const ticketIds = tickets.map((ticket) => ticket.ticketId);

      // 3. Actualizar tickets del usuario
      console.log('Actualizando tickets de usuario:', {
        userId: sale.Item.userId,
        ticketIds,
        resellerId: sale.Item.resellerId,
      });
      await this.usersService.updateUserTickets(
        sale.Item.userId,
        ticketIds,
        sale.Item.resellerId,
      );

      // 4. Obtener datos para el email
      const user = await this.usersService.getUserProfile(sale.Item.userId);
      const event = await this.eventsService.findOne(sale.Item.eventId);
      const batch = await this.batchesService.findOne(
        sale.Item.eventId,
        sale.Item.batchId,
      );

      // 5. Obtener QR attachments
      const qrAttachments = await Promise.all(
        tickets.map(async (ticket, index) => {
          try {
            const qrKey = ticket.qrS3Url
              .split('.amazonaws.com/')[1]
              .replace(/^\/+/, '');
            const s3Response = await this.s3Client.send(
              new GetObjectCommand({
                Bucket:
                  this.configService.get<string>('S3_BUCKET') ||
                  'ticket-qr-bucket-dev-v2',
                Key: qrKey,
              }),
            );
            if (!s3Response.Body) {
              throw new Error(`No body returned for QR code with key: ${qrKey}`);
            }
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

      // 6. Obtener nombre del revendedor (simplificado - usar email o intentar desde Cognito)
      let resellerName = resellerEmail;
      try {
        // Intentar obtener desde Cognito usando el client de usersService a través de getAllUsers
        // que ya enriquece los usuarios con datos de Cognito
        const saleItem = sale.Item;
        if (saleItem) {
          const allUsers = await this.usersService.getAllUsers();
          const resellerUser = allUsers.find(u => u.id === saleItem.resellerId);
          if (resellerUser && resellerUser.given_name && resellerUser.family_name) {
            resellerName = `${resellerUser.given_name} ${resellerUser.family_name}`;
          } else if (resellerUser && resellerUser.given_name) {
            resellerName = resellerUser.given_name;
          }
        }
      } catch (error: any) {
        console.log('No se pudo obtener nombre del revendedor, usando email:', error?.message);
        // Si falla, usar el email como fallback (ya está asignado arriba)
      }

      // 7. Enviar email especial para ticket gratis
      const userName = user.alias || user.email?.split('@')[0] || 'Usuario';
      const userEmail = user.email;
      
      if (!userEmail) {
        console.error('Usuario sin email:', { userId: sale.Item.userId, user });
        throw new HttpException(
          'No se pudo obtener el email del usuario para enviar el ticket',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      const emailBody = `
Hola ${userName},

¡Tienes un ticket gratuito!

**Ticket Gratuito Cortesía de ${resellerName}**

- Venta ID: ${saleId}
- Evento: ${event?.name || 'Desconocido'}
- Tanda: ${batch?.name || 'Desconocida'}
- Cantidad de tickets: ${sale.Item.quantity}
- Precio: GRATIS ✨
- Tickets: ${ticketIds.join(', ')}

**Códigos QR Únicos**
Los códigos QR de tus tickets están adjuntos en este correo.

¡Disfruta del evento!

Equipo Groove Tickets
      `;

      console.log('Enviando email de ticket gratis a:', userEmail);
      await this.emailService.sendConfirmationEmail(
        userEmail,
        `Ticket Gratuito - ${event?.name || 'Evento'}`,
        emailBody,
        qrAttachments,
      );
      console.log('Email de ticket gratis enviado exitosamente');

      return { ...sale.Item, tickets };
    } catch (error) {
      console.error('Error en confirmFreeSale:', {
        saleId,
        error: error.message,
      });
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Error al confirmar la venta gratis: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
