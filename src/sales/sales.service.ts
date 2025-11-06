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
        
        // Obtener batch para verificar si es VIP
        console.log('Obteniendo tanda para verificar VIP:', {
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
        });
        const batch = await this.batchesService.findOne(
          sale.Item.eventId,
          sale.Item.batchId,
        );
        const isVip = batch?.isVip || false;
        
        console.log('Creando tickets para venta:', { saleId, isVip });
        const tickets = await this.ticketsService.createTickets({
          id: saleId,
          userId: sale.Item.userId,
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
          quantity: sale.Item.quantity,
          isVip,
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
Equipo FEST-GO
        `;

        // Obtener URL del portal
        const ticketsPortalUrl = this.configService.get<string>('FRONTEND_BASE_URL') || 'https://fest-go.com';
        const userName = user.alias || user.email?.split('@')[0] || 'Usuario';

        const emailHtmlBody = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Confirmación de compra</title>
  <style>
    /* Estilos mínimos para clientes que respetan <style>; todo lo crítico va inline */
    @media (prefers-color-scheme: dark) {
      .bg { background-color: #0f172a !important; }
      .card { background-color: #111827 !important; border-color: #1f2937 !important; }
      .text { color: #e5e7eb !important; }
      .muted { color: #9ca3af !important; }
      .divider { border-color: #1f2937 !important; }
      .btn { background: #6d28d9 !important; }
    }
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; }
      .px { padding-left: 16px !important; padding-right: 16px !important; }
    }
    /* Outlook */
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; }
  </style>
</head>
<body style="margin:0; padding:0; background:#0b1220;" class="bg">
  <center style="width:100%; background:#0b1220;">
    <div style="max-width:600px; margin:0 auto;" class="container">
      <!-- Spacer -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr><td height="24"></td></tr>
      </table>


      <!-- Title Card -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr><td height="16"></td></tr>
        <tr>
          <td class="px" style="padding:0 24px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="card" style="border-collapse:collapse; background:#0f172a; border:1px solid #1f2937; border-radius:12px;">
              <tr>
                <td style="padding:28px;">
                  <h1 class="text" style="margin:0 0 8px; font-family:Arial,Helvetica,sans-serif; font-size:22px; line-height:28px; color:#e5e7eb;">
                    ¡Compra confirmada, ${userName}! 🎉
                  </h1>
                  <p class="muted" style="margin:0; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:20px; color:#9ca3af;">
                    Tus tickets están listos. Guarda este email y presenta los QR en la entrada.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Details -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr><td height="16"></td></tr>
        <tr>
          <td class="px" style="padding:0 24px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="card" style="border-collapse:collapse; background:#0f172a; border:1px solid #1f2937; border-radius:12px;">
              <tr>
                <td style="padding:20px 24px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse; font-family:Arial,Helvetica,sans-serif; font-size:14px;">
                    <tr>
                      <td class="text" style="color:#e5e7eb; padding:8px 0;"><strong>Venta ID:</strong> ${saleId}</td>
                    </tr>
                    <tr>
                      <td class="text" style="color:#e5e7eb; padding:8px 0;"><strong>Evento:</strong> ${event?.name || 'Desconocido'}</td>
                    </tr>
                    <tr>
                      <td class="text" style="color:#e5e7eb; padding:8px 0;"><strong>Tanda:</strong> ${batch?.name || 'Desconocida'}</td>
                    </tr>
                    <tr>
                      <td class="text" style="color:#e5e7eb; padding:8px 0;"><strong>Cantidad:</strong> ${sale.Item.quantity}</td>
                    </tr>
                    <tr>
                      <td class="text" style="color:#e5e7eb; padding:8px 0;"><strong>Precio por ticket:</strong> $${sale.Item.basePrice}</td>
                    </tr>
                    <tr>
                      <td class="text" style="color:#e5e7eb; padding:8px 0;"><strong>Comisión:</strong> $${sale.Item.commission}</td>
                    </tr>
                    <tr>
                      <td class="text" style="color:#e5e7eb; padding:8px 0;"><strong>Total abonado:</strong> <span style="color:#a78bfa; font-weight:bold;">$${sale.Item.total}</span></td>
                    </tr>
                    <tr>
                      <td class="text" style="color:#e5e7eb; padding:8px 0;"><strong>Tickets:</strong> ${ticketIds.join(', ')}</td>
                    </tr>
                  </table>

                  <!-- Divider -->
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                    <tr><td class="divider" style="border-top:1px solid #1f2937;" height="16"></td></tr>
                  </table>

                  <p class="text" style="margin:0 0 16px; color:#e5e7eb; font-family:Arial,Helvetica,sans-serif;">
                    Los códigos QR están adjuntos como imágenes. Cada ticket tiene su QR único.
                  </p>

                  <!-- CTA -->
                  <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0; border-collapse:separate;">
                    <tr>
                      <td>
                        <a href="${ticketsPortalUrl}"
                           class="btn"
                           style="background:#7c3aed; color:#ffffff; text-decoration:none; display:inline-block; padding:12px 18px; border-radius:8px; font-family:Arial,Helvetica,sans-serif; font-size:14px;">
                           Ver tickets en mi cuenta
                        </a>
                      </td>
                    </tr>
                  </table>

                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Footer -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr><td height="16"></td></tr>
        <tr>
          <td class="px" style="padding:0 24px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
              <tr>
                <td class="muted" style="text-align:center; color:#9ca3af; font-family:Arial,Helvetica,sans-serif; font-size:12px; padding:12px 0;">
                  © ${new Date().getFullYear()} FEST-GO · No responder a este email
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td height="24"></td></tr>
      </table>
    </div>
  </center>
</body>
</html>
        `;

        console.log('Enviando email a:', user.email);
        await this.emailService.sendConfirmationEmail(
          user.email,
          `Confirmación de Compra - ${event?.name || 'Evento'}`,
          emailBody,
          qrAttachments,
          emailHtmlBody,
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

    try {
      // 1. Validar que el usuario comprador existe
      let buyer;
      try {
        buyer = await this.usersService.getUserByEmailOrAlias(buyerEmailOrAlias);
        if (!buyer) {
          throw new HttpException(
            'El email o alias del comprador no está registrado',
            HttpStatus.BAD_REQUEST,
          );
        }
      } catch (buyerError: any) {
        console.error('Error al buscar usuario comprador:', buyerError.message);
        if (buyerError instanceof HttpException) {
          throw buyerError;
        }
        throw new HttpException(
          'Error al buscar el usuario comprador',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // 2. Validar evento y batch
      let event;
      try {
        event = await this.eventsService.findOne(eventId);
        if (!event) {
          throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
        }
      } catch (eventError: any) {
        console.error('Error al buscar evento:', eventError.message);
        if (eventError instanceof HttpException) {
          throw eventError;
        }
        throw new HttpException(
          'Error al buscar el evento',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      let batch;
      try {
        batch = await this.batchesService.findOne(eventId, batchId);
        if (!batch || batch.availableTickets < quantity) {
          throw new HttpException(
            'No hay suficientes tickets disponibles en la tanda',
            HttpStatus.BAD_REQUEST,
          );
        }
      } catch (batchError: any) {
        console.error('Error al buscar batch:', batchError.message);
        if (batchError instanceof HttpException) {
          throw batchError;
        }
        throw new HttpException(
          'Error al buscar la tanda',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // 3. Validar límite del 25% de tickets gratis
      let totalEventTickets = 0;
      let freeTicketsCount = 0;
      try {
        totalEventTickets = await this.getTotalEventTickets(eventId);
        freeTicketsCount = await this.getFreeTicketsCount(eventId);
        const maxFreeTickets = Math.floor(totalEventTickets * 0.25);
        const freeTicketsAfterThis = freeTicketsCount + quantity;

        if (freeTicketsAfterThis > maxFreeTickets) {
          throw new HttpException(
            `No se pueden generar más tickets gratis. Límite del 25% alcanzado (${freeTicketsCount}/${maxFreeTickets} tickets gratis ya generados). Puedes generar hasta ${maxFreeTickets - freeTicketsCount} tickets más.`,
            HttpStatus.BAD_REQUEST,
          );
        }
      } catch (limitError: any) {
        console.error('Error al validar límite de tickets gratis:', limitError.message);
        if (limitError instanceof HttpException) {
          throw limitError;
        }
        // Si falla la validación del límite, continuar con advertencia
        console.warn('No se pudo validar el límite del 25%, continuando...');
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
        console.log('Venta gratis registrada en DynamoDB:', saleId);
      } catch (dbError: any) {
        console.error('Error al registrar venta en DynamoDB:', dbError.message);
        throw new HttpException(
          'Error al registrar la venta en la base de datos',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // 5. Confirmar la venta gratis (genera tickets, envía email, etc.)
      try {
        await this.confirmFreeSale(saleId, resellerEmail);
      } catch (confirmError: any) {
        console.error('Error al confirmar venta gratis:', confirmError.message);
        // La venta ya está creada, retornamos éxito parcial
        console.warn('Venta creada pero hubo errores en la confirmación:', saleId);
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
          warning: 'Venta creada pero hubo errores en la generación de tickets o envío de email',
        };
      }

      console.log('Venta gratis creada exitosamente:', { saleId, buyerId: buyer.id, resellerId });
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
    } catch (error: any) {
      console.error('Error en createFreeSale:', {
        message: error.message,
        stack: error.stack,
        saleId,
      });
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Error al procesar venta gratis: ${error?.message || 'Error desconocido'}`,
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
      try {
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
      } catch (decrementError: any) {
        console.error('Error al decrementar tickets del batch:', decrementError.message);
        throw new HttpException(
          'Error al actualizar el stock de tickets',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // 2. Obtener batch para verificar si es VIP (también se usa para el email)
      let isVip = false;
      let batch;
      try {
        console.log('Obteniendo tanda para verificar VIP (venta gratis):', {
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
        });
        batch = await this.batchesService.findOne(
          sale.Item.eventId,
          sale.Item.batchId,
        );
        isVip = batch?.isVip || false;
      } catch (batchError: any) {
        console.error('Error al obtener batch, asumiendo no VIP:', batchError.message);
        batch = { name: 'Tanda' }; // Valor por defecto para el email
      }

      // 3. Crear tickets
      let tickets;
      let ticketIds: string[] = [];
      try {
        console.log('Creando tickets para venta gratis:', { saleId, isVip });
        tickets = await this.ticketsService.createTickets({
          id: saleId,
          userId: sale.Item.userId,
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
          quantity: sale.Item.quantity,
          isVip,
        });
        ticketIds = tickets.map((ticket) => ticket.ticketId);
      } catch (ticketsError: any) {
        console.error('Error al crear tickets:', ticketsError.message);
        throw new HttpException(
          'Error al generar los tickets con QR',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // 4. Actualizar tickets del usuario
      try {
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
      } catch (updateError: any) {
        console.error('Error al actualizar tickets del usuario:', updateError.message);
        // No lanzar error aquí, continuar con el email aunque falle la actualización
        console.warn('La venta y tickets se crearon, pero falló la actualización de contadores');
      }

      // 5. Obtener datos para el email
      let user, event;
      try {
        user = await this.usersService.getUserProfile(sale.Item.userId);
        event = await this.eventsService.findOne(sale.Item.eventId);
        // batch ya fue obtenido arriba, reutilizarlo
      } catch (dataError: any) {
        console.error('Error al obtener datos para el email:', dataError.message);
        // Continuar con valores por defecto
        if (!user) user = { email: '', alias: 'Usuario' };
        if (!event) event = { name: 'Evento' };
        if (!batch) batch = { name: 'Tanda' };
      }

      // 6. Obtener QR attachments (si falla algún QR, continuar con los que sí funcionen)
      const qrAttachments: any[] = [];
      await Promise.all(
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
            qrAttachments.push({
              content: buffer.toString('base64'),
              filename: `ticket-${index + 1}-${ticket.ticketId}.png`,
              type: 'image/png',
              disposition: 'attachment',
              contentId: `qr-${ticket.ticketId}`,
            });
          } catch (qrError: any) {
            console.error(
              `Error fetching QR code for ticket ${ticket.ticketId}:`,
              qrError.message,
            );
            // Continuar sin este QR, pero loguear el error
          }
        }),
      );
      
      if (qrAttachments.length === 0) {
        console.warn('No se pudo obtener ningún QR code para adjuntar al email');
      }

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

      // 7. Enviar email especial para ticket gratis (si falla, no detener todo el proceso)
      const userName = user?.alias || user?.email?.split('@')[0] || 'Usuario';
      const userEmail = user?.email;
      
      if (!userEmail) {
        console.error('Usuario sin email, no se enviará email:', { userId: sale.Item.userId, user });
        // No lanzar error, solo loguear - los tickets ya están creados
      } else {
        try {
          const emailBody = `
Hola ${userName},

¡FELICIDADES! Tienes un ticket GRATUITO 🎉

🎁 TICKET GRATIS - CORTESÍA DE ${resellerName}

Este ticket ha sido generado especialmente para ti por tu revendedor. ¡Es completamente GRATIS!

═══════════════════════════════════════
📋 DETALLES DEL TICKET GRATUITO
═══════════════════════════════════════
• Venta ID: ${saleId}
• Evento: ${event?.name || 'Desconocido'}
• Tanda: ${batch?.name || 'Desconocida'}
• Cantidad de tickets: ${sale.Item.quantity}
• Precio: $0.00 (GRATIS) ✨
• Tickets: ${ticketIds.join(', ')}

═══════════════════════════════════════
📱 CÓDIGOS QR ÚNICOS
═══════════════════════════════════════
Los códigos QR de tus tickets están adjuntos en este correo.
Estos códigos QR son válidos y funcionan igual que los tickets pagos.

¡Disfruta del evento! 🎊

Saludos,
Equipo FEST-GO
          `;

          // Obtener URL del portal
          const ticketsPortalUrl = this.configService.get<string>('FRONTEND_BASE_URL') || 'https://fest-go.com';

          const emailHtmlBody = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Ticket gratuito</title>
  <style>
    @media (prefers-color-scheme: dark) {
      .bg { background-color: #0f172a !important; }
      .card { background-color: #111827 !important; border-color: #1f2937 !important; }
      .text { color: #e5e7eb !important; }
      .muted { color: #9ca3af !important; }
      .badge { background:#22c55e !important; color:#052e16 !important; }
      .btn { background:#16a34a !important; }
    }
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; }
      .px { padding-left:16px !important; padding-right:16px !important; }
    }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { -ms-interpolation-mode:bicubic; }
  </style>
</head>
<body style="margin:0; padding:0; background:#0b1220;" class="bg">
  <center style="width:100%; background:#0b1220;">
    <div style="max-width:600px; margin:0 auto;" class="container">
      <table role="presentation" width="100%"><tr><td height="24"></td></tr></table>


      <!-- Título + badge -->
      <table role="presentation" width="100%">
        <tr><td height="16"></td></tr>
        <tr>
          <td class="px" style="padding:0 24px;">
            <table role="presentation" width="100%" class="card" style="background:#0f172a; border:1px solid #1f2937; border-radius:12px;">
              <tr>
                <td style="padding:28px; text-align:left;">
                  <h1 class="text" style="margin:0 0 8px; font-family:Arial,Helvetica,sans-serif; font-size:22px; color:#e5e7eb;">
                    ¡Ticket GRATUITO para ${event?.name || 'tu evento'}! 🎁
                  </h1>
                  <div class="badge" style="display:inline-block; background:#22c55e; color:#052e16; font-weight:bold; padding:8px 12px; border-radius:999px; font-family:Arial,Helvetica,sans-serif; font-size:12px;">
                    Cortesía de ${resellerName}
                  </div>
                  <p class="muted" style="margin:12px 0 0; font-family:Arial,Helvetica,sans-serif; color:#9ca3af; font-size:14px;">
                    Hola <strong style="color:#e5e7eb;">${userName}</strong>, tu entrada es 100% gratis. ¡Nos vemos en el show!
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Detalles -->
      <table role="presentation" width="100%">
        <tr><td height="16"></td></tr>
        <tr>
          <td class="px" style="padding:0 24px;">
            <table role="presentation" width="100%" class="card" style="background:#0f172a; border:1px solid #1f2937; border-radius:12px;">
              <tr>
                <td style="padding:20px 24px;">
                  <table role="presentation" width="100%" style="font-family:Arial,Helvetica,sans-serif; font-size:14px;">
                    <tr><td class="text" style="padding:8px 0; color:#e5e7eb;"><strong>Venta ID:</strong> ${saleId}</td></tr>
                    <tr><td class="text" style="padding:8px 0; color:#e5e7eb;"><strong>Evento:</strong> ${event?.name || 'Desconocido'}</td></tr>
                    <tr><td class="text" style="padding:8px 0; color:#e5e7eb;"><strong>Tanda:</strong> ${batch?.name || 'Desconocida'}</td></tr>
                    <tr><td class="text" style="padding:8px 0; color:#e5e7eb;"><strong>Cantidad:</strong> ${sale.Item.quantity}</td></tr>
                    <tr><td class="text" style="padding:8px 0; color:#e5e7eb;"><strong>Precio:</strong> <span style="color:#22c55e; font-weight:bold;">$0.00 (GRATIS)</span></td></tr>
                    <tr><td class="text" style="padding:8px 0; color:#e5e7eb;"><strong>Tickets:</strong> ${ticketIds.join(', ')}</td></tr>
                  </table>

                  <table role="presentation" width="100%"><tr><td style="border-top:1px solid #1f2937;" height="16"></td></tr></table>

                  <p class="text" style="margin:0 0 16px; color:#e5e7eb; font-family:Arial,Helvetica,sans-serif;">
                    Adjuntamos los QR únicos de tus tickets. Funcionan igual que las entradas pagas.
                  </p>

                  <a href="${ticketsPortalUrl}"
                     class="btn"
                     style="background:#16a34a; color:#ffffff; text-decoration:none; display:inline-block; padding:12px 18px; border-radius:8px; font-family:Arial,Helvetica,sans-serif; font-size:14px;">
                     Ver mis tickets
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Footer -->
      <table role="presentation" width="100%">
        <tr><td height="16"></td></tr>
        <tr>
          <td class="px" style="padding:0 24px;">
            <p class="muted" style="text-align:center; color:#9ca3af; font-family:Arial,Helvetica,sans-serif; font-size:12px; margin:12px 0 24px;">
              © ${new Date().getFullYear()} FEST-GO
            </p>
          </td>
        </tr>
      </table>
    </div>
  </center>
</body>
</html>
          `;

          console.log('Enviando email de ticket gratis a:', userEmail);
          await this.emailService.sendConfirmationEmail(
            userEmail,
            `🎁 Ticket Gratuito - ${event?.name || 'Evento'}`,
            emailBody,
            qrAttachments,
            emailHtmlBody,
          );
          console.log('Email de ticket gratis enviado exitosamente');
        } catch (emailError: any) {
          console.error('Error al enviar email de ticket gratis:', emailError.message);
          // No lanzar error - los tickets ya están creados y el usuario puede verlos en su cuenta
          console.warn('Los tickets fueron creados pero el email no se pudo enviar');
        }
      }

      return { ...sale.Item, tickets };
    } catch (error: any) {
      console.error('Error en confirmFreeSale:', {
        saleId,
        error: error?.message,
        stack: error?.stack,
      });
      // Re-lanzar el error para que createFreeSale pueda manejarlo
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Error al confirmar la venta gratis: ${error?.message || 'Error desconocido'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
