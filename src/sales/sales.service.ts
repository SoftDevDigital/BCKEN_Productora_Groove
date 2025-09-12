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
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { CreateSaleDto } from './dto/create-sale.dto';
import { v4 as uuidv4 } from 'uuid';
import { EventsService } from '../events/events.service';
import { BatchesService } from '../batches/batches.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class SalesService {
  private readonly tableName = 'Sales-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly sesClient: SESClient;

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
    // Validar evento
    const event = await this.eventsService.findOne(eventId);
    if (!event) {
      throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
    }
    // Validar tanda y precio
    const batch = await this.batchesService.findOne(eventId, batchId);
    if (!batch || batch.availableTickets < quantity) {
      throw new HttpException(
        'No hay suficientes tickets en la tanda',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Calcular precio y comisión
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
      const result = await this.docClient.send(new UpdateCommand(updateParams));
      if (paymentStatus === 'approved') {
        // Restar tickets
        await this.batchesService.decrementTickets(
          sale.Item.eventId,
          sale.Item.batchId,
          sale.Item.quantity,
        );
        // Generar tickets individuales con QR
        const tickets = await this.ticketsService.createTickets({
          id: saleId,
          userId: sale.Item.userId,
          eventId: sale.Item.eventId,
          batchId: sale.Item.batchId,
          quantity: sale.Item.quantity,
        });
        // Actualizar perfil de usuario y revendedor
        const ticketIds = tickets.map((ticket) => ticket.ticketId);
        await this.usersService.updateUserTickets(
          sale.Item.userId,
          ticketIds,
          sale.Item.resellerId,
        );
        // Obtener email del usuario y alias
        const user = await this.usersService.getUserProfile(sale.Item.userId);
        const event = await this.eventsService.findOne(sale.Item.eventId);
        const batch = await this.batchesService.findOne(
          sale.Item.eventId,
          sale.Item.batchId,
        );
        // Enviar email de confirmación con QRs
        const qrLinks = tickets.map((ticket) => ticket.qrS3Url).join(', ');
        const emailParams = {
          Source:
            this.configService.get<string>('SES_EMAIL') ||
            'tu-email@dominio.com',
          Destination: {
            ToAddresses: [user.email],
          },
          Message: {
            Subject: {
              Data: `Confirmación de Compra - ${event?.name || 'Evento'}`,
            },
            Body: {
              Text: {
                Data: `Hola ${user.alias || 'Usuario'},\n\nTu compra ha sido confirmada exitosamente.\n\nDetalles de la compra:\n- Venta ID: ${saleId}\n- Evento: ${event?.name || 'Desconocido'}\n- Tanda: ${batch?.name || 'Desconocida'}\n- Cantidad: ${sale.Item.quantity}\n- Importe abonado: $${sale.Item.total}\n- Tickets: ${ticketIds.join(', ')}\n- QRs: ${qrLinks}\n\n¡Gracias por tu compra!\nEquipo Groove Tickets`,
              },
            },
          },
        };
        await this.sesClient.send(new SendEmailCommand(emailParams));
        return { ...result.Attributes, tickets };
      }
      return result.Attributes;
    } catch (error) {
      throw new HttpException(
        'Error al confirmar la venta',
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