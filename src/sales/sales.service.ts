import {
  Injectable,
  Inject,
  HttpException,
  HttpStatus,
  forwardRef,
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

@Injectable()
export class SalesService {
  private readonly tableName = 'Sales-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly sesClient: SESClient;
  private readonly mpClient: MercadoPagoConfig;

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
      accessToken: 'APP_USR-8581189409054279-091018-c6d03928f1a9466fb3fbc1cdbcf80512-2369426390', // Token hardcodeado
    });
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
      throw new HttpException('Error al registrar la venta', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async generatePaymentLink(saleId: string, amount: number, title: string): Promise<string> {
    this.validateId(saleId, 'saleId');
    this.validateNumber(amount, 'amount', true);

    const preference = new Preference(this.mpClient);
    const apiBaseUrl = this.configService.get<string>('API_BASE_URL');
    if (!apiBaseUrl || !apiBaseUrl.match(/^https?:\/\/[^\s/$.?#].[^\s]*$/)) {
      throw new HttpException('API_BASE_URL no está configurado o es inválido', HttpStatus.INTERNAL_SERVER_ERROR);
    }

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
        success: `${apiBaseUrl}/payments/success`,
        failure: `${apiBaseUrl}/payments/failure`,
        pending: `${apiBaseUrl}/payments/pending`,
      },
      auto_return: 'approved',
      external_reference: saleId,
      notification_url: `${apiBaseUrl}/sales/webhook`,
    };

    try {
      const response = await preference.create({ body: preferenceData });
      return response.init_point || '';
    } catch (error) {
      throw new HttpException(`Error al generar link de pago: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
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
      throw new HttpException('Error al enviar email de pago', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async confirmSale(saleId: string, paymentStatus: string, paymentId: string) {
    this.validateId(saleId, 'saleId');
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
        // Generar tickets individuales
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
        // Obtener email del usuario
        const user = await this.usersService.getUserProfile(sale.Item.userId);
        const event = await this.eventsService.findOne(sale.Item.eventId);
        const batch = await this.batchesService.findOne(
          sale.Item.eventId,
          sale.Item.batchId,
        );
        // Enviar email de confirmación
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
                Data: `Hola,\n\nTu compra ha sido confirmada exitosamente.\n\nDetalles de la compra:\n- Venta ID: ${saleId}\n- Evento: ${event?.name || 'Desconocido'}\n- Tanda: ${batch?.name || 'Desconocida'}\n- Cantidad: ${sale.Item.quantity}\n- Total: $${sale.Item.total}\n- Tickets: ${ticketIds.join(', ')}\n\n¡Gracias por tu compra!\nEquipo Groove Tickets`,
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
}