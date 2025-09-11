import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { SalesService } from '../sales/sales.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import { EventsService } from '../events/events.service';
import { BatchesService } from '../batches/batches.service';

@Injectable()
export class ReportsService {
  private readonly salesTable = 'Sales-v2';
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private readonly salesService: SalesService,
    private readonly ticketsService: TicketsService,
    private readonly usersService: UsersService,
    private readonly eventsService: EventsService,
    private readonly batchesService: BatchesService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
  }

  async getSalesReport() {
    try {
      const salesResult = await this.docClient.send(
        new ScanCommand({ TableName: this.salesTable }),
      );
      const sales = salesResult.Items || [];

      const totalSales = sales.length;
      const totalRevenue = sales.reduce(
        (sum, sale) => sum + (sale.total || 0),
        0,
      );
      const salesByType = {
        direct: sales.filter((sale) => sale.type === 'direct').length,
        reseller: sales.filter((sale) => sale.type === 'reseller').length,
      };
      const ticketsSold = sales.reduce(
        (sum, sale) => sum + (sale.quantity || 0),
        0,
      );

      const salesByEvent = {};
      for (const sale of sales) {
        const eventId = sale.eventId;
        if (!salesByEvent[eventId]) {
          const event = await this.eventsService.findOne(eventId);
          salesByEvent[eventId] = {
            eventName: event?.name || 'Unknown',
            totalSales: 0,
            totalTickets: 0,
            totalRevenue: 0,
            batches: {},
          };
        }
        salesByEvent[eventId].totalSales += 1;
        salesByEvent[eventId].totalTickets += sale.quantity;
        salesByEvent[eventId].totalRevenue += sale.total;

        const batchId = sale.batchId;
        if (!salesByEvent[eventId].batches[batchId]) {
          const batch = await this.batchesService.findOne(eventId, batchId);
          salesByEvent[eventId].batches[batchId] = {
            batchName: batch?.name || 'Unknown',
            ticketsSold: 0,
            revenue: 0,
          };
        }
        salesByEvent[eventId].batches[batchId].ticketsSold += sale.quantity;
        salesByEvent[eventId].batches[batchId].revenue += sale.total;
      }

      return {
        totalSales,
        totalRevenue,
        ticketsSold,
        salesByType,
        salesByEvent,
      };
    } catch (error) {
      throw new HttpException(
        'Error al generar reporte de ventas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getSaleDetails(saleId: string) {
    try {
      const sale = await this.docClient.send(
        new GetCommand({
          TableName: this.salesTable,
          Key: { id: saleId },
        }),
      );
      if (!sale.Item) {
        throw new HttpException('Venta no encontrada', HttpStatus.NOT_FOUND);
      }

      const tickets = await this.docClient.send(
        new ScanCommand({
          TableName: 'Tickets-v2',
          FilterExpression: 'saleId = :saleId',
          ExpressionAttributeValues: { ':saleId': saleId },
        }),
      );

      const user = await this.usersService.getUserProfile(sale.Item.userId);
      const reseller = sale.Item.resellerId
        ? await this.usersService.getUserProfile(sale.Item.resellerId)
        : null;
      const event = await this.eventsService.findOne(sale.Item.eventId);
      const batch = await this.batchesService.findOne(
        sale.Item.eventId,
        sale.Item.batchId,
      );

      if (!event) {
        throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
      }
      if (!batch) {
        throw new HttpException('Tanda no encontrada', HttpStatus.NOT_FOUND);
      }

      return {
        sale: sale.Item,
        tickets: tickets.Items || [],
        buyer: {
          id: user.id,
          role: user.role,
          purchasedTickets: user.purchasedTickets,
        },
        reseller: reseller
          ? {
              id: reseller.id,
              role: reseller.role,
              soldTickets: reseller.soldTickets,
            }
          : null,
        event: { id: event.id, name: event.name },
        batch: { id: batch.batchId, name: batch.name },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al obtener detalles de venta',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getUsersReport() {
    try {
      const users = await this.usersService.getAllUsers();
      return users;
    } catch (error) {
      throw new HttpException(
        'Error al generar reporte de usuarios',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
