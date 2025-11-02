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
import { User } from '../users/users/types';

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
      // Considerar solo ventas aprobadas para métricas de tickets y recaudación
      const approvedSales = sales.filter((sale) => sale.status === 'approved');
      const totalSales = approvedSales.length;
      const totalRevenue = approvedSales.reduce(
        (sum, sale) => sum + (sale.total || 0),
        0,
      );
      const salesByType = {
        direct: approvedSales.filter((sale) => sale.type === 'direct').length,
        reseller: approvedSales.filter((sale) => sale.type === 'reseller').length,
      };
      const freeSales = approvedSales.filter((sale) => sale.isFree === true);
      const paidSales = approvedSales.filter((sale) => !sale.isFree || sale.isFree === false);
      const ticketsSold = approvedSales.reduce(
        (sum, sale) => sum + (sale.quantity || 0),
        0,
      );
      const freeTicketsSold = freeSales.reduce(
        (sum, sale) => sum + (sale.quantity || 0),
        0,
      );
      const paidRevenue = paidSales.reduce(
        (sum, sale) => sum + (sale.total || 0),
        0,
      );
      const salesByEvent = {};
      for (const sale of approvedSales) {
        const eventId = sale.eventId;
        if (!salesByEvent[eventId]) {
          const event = await this.eventsService.findOne(eventId);
          salesByEvent[eventId] = {
            eventName: event?.name || 'Unknown',
            from: event?.from || 'Unknown',
            to: event?.to || 'Unknown',
            totalSales: 0,
            totalTickets: 0,
            totalRevenue: 0,
            freeTickets: 0,
            freeSales: 0,
            batches: {},
          };
        }
        salesByEvent[eventId].totalSales += 1;
        salesByEvent[eventId].totalTickets += sale.quantity;
        salesByEvent[eventId].totalRevenue += sale.total || 0;
        if (sale.isFree === true) {
          salesByEvent[eventId].freeTickets += sale.quantity;
          salesByEvent[eventId].freeSales += 1;
        }
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
        paidRevenue,
        ticketsSold,
        freeTicketsSold,
        freeSalesCount: freeSales.length,
        paidSalesCount: paidSales.length,
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
        sale: {
          ...sale.Item,
          saleType: sale.Item.isFree ? 'VENTA GRATIS' : 'VENTA PAGADA',
        },
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
        event: {
          id: event.id,
          name: event.name,
          from: event.from,
          to: event.to,
        },
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

  async getUsersReport(): Promise<User[]> {
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

  async getResellersReport() {
    try {
      // Get all users with reseller role
      const allUsers = await this.usersService.getAllUsers();
      const resellers = allUsers.filter(user => user.role === 'Reseller');

      // Get all approved sales
      const salesResult = await this.docClient.send(
        new ScanCommand({
          TableName: this.salesTable,
          FilterExpression: '#status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': 'approved' },
        }),
      );
      const approvedSales = salesResult.Items || [];

      // Calculate stats for each reseller
      const resellerStats = await Promise.all(
        resellers.map(async (reseller) => {
          // Filter sales for this reseller
          const resellerSales = approvedSales.filter(sale => sale.resellerId === reseller.id);
          
          // Calculate totals
          const totalTicketsSold = resellerSales.reduce((sum, sale) => sum + (sale.quantity || 0), 0);
          const totalRevenue = resellerSales.reduce((sum, sale) => sum + (sale.total || 0), 0);
          const totalSales = resellerSales.length;
          
          // Separate free and paid sales
          const freeSales = resellerSales.filter(sale => sale.isFree === true);
          const paidSales = resellerSales.filter(sale => !sale.isFree || sale.isFree === false);
          const freeTicketsSold = freeSales.reduce((sum, sale) => sum + (sale.quantity || 0), 0);
          const paidTicketsSold = paidSales.reduce((sum, sale) => sum + (sale.quantity || 0), 0);
          const freeSalesCount = freeSales.length;
          const paidSalesCount = paidSales.length;
          
          // Calculate average ticket price
          const averageTicketPrice = totalTicketsSold > 0 ? totalRevenue / totalTicketsSold : 0;
          
          // Get sales by event for this reseller
          const salesByEvent = {};
          for (const sale of resellerSales) {
            const eventId = sale.eventId;
            if (!salesByEvent[eventId]) {
              const event = await this.eventsService.findOne(eventId);
              salesByEvent[eventId] = {
                eventName: event?.name || 'Unknown',
                ticketsSold: 0,
                revenue: 0,
                sales: 0,
                freeTickets: 0,
                freeSales: 0,
              };
            }
            salesByEvent[eventId].ticketsSold += sale.quantity;
            salesByEvent[eventId].revenue += sale.total || 0;
            salesByEvent[eventId].sales += 1;
            
            if (sale.isFree === true) {
              salesByEvent[eventId].freeTickets += sale.quantity;
              salesByEvent[eventId].freeSales += 1;
            }
          }

          return {
            resellerId: reseller.id,
            name: `${reseller.given_name} ${reseller.family_name}`,
            email: reseller.email,
            totalSales,
            paidSalesCount,
            freeSalesCount: freeSalesCount,
            totalTicketsSold,
            paidTicketsSold,
            freeTicketsSold,
            totalRevenue,
            averageTicketPrice: Math.round(averageTicketPrice * 100) / 100,
            salesByEvent,
            createdAt: reseller.createdAt,
          };
        }),
      );

      // Sort by total revenue descending
      resellerStats.sort((a, b) => b.totalRevenue - a.totalRevenue);

      // Calculate overall stats
      const totalResellers = resellerStats.length;
      const totalRevenueAll = resellerStats.reduce((sum, reseller) => sum + reseller.totalRevenue, 0);
      const totalTicketsAll = resellerStats.reduce((sum, reseller) => sum + reseller.totalTicketsSold, 0);
      const totalSalesAll = resellerStats.reduce((sum, reseller) => sum + reseller.totalSales, 0);

      return {
        summary: {
          totalResellers,
          totalRevenue: totalRevenueAll,
          totalTicketsSold: totalTicketsAll,
          totalSales: totalSalesAll,
          averageRevenuePerReseller: totalResellers > 0 ? Math.round((totalRevenueAll / totalResellers) * 100) / 100 : 0,
        },
        resellers: resellerStats,
      };
    } catch (error) {
      console.error('Error al generar reporte de revendedores:', error);
      throw new HttpException(
        'Error al generar reporte de revendedores',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Obtiene el conteo de tickets escaneados por evento
   * Método nuevo que no afecta la lógica existente
   */
  async getScansCountByEvent(eventId: string): Promise<{ eventId: string; scansCount: number }> {
    try {
      const scansCount = await this.ticketsService.getScansCountByEvent(eventId);
      return {
        eventId,
        scansCount,
      };
    } catch (error) {
      console.error('Error al obtener conteo de escaneos por evento:', error);
      // Retornar 0 si hay error para no romper nada
      return {
        eventId,
        scansCount: 0,
      };
    }
  }

  /**
   * Obtiene el conteo total de tickets escaneados
   * Método nuevo que no afecta la lógica existente
   */
  async getTotalScansCount(): Promise<{ totalScans: number }> {
    try {
      const totalScans = await this.ticketsService.getTotalScansCount();
      return {
        totalScans,
      };
    } catch (error) {
      console.error('Error al obtener conteo total de escaneos:', error);
      // Retornar 0 si hay error para no romper nada
      return {
        totalScans: 0,
      };
    }
  }
}
