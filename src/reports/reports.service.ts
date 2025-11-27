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
      
      // Contar tickets VIP y After (necesitamos obtener el batch para cada venta)
      let vipTicketsSold = 0;
      let afterTicketsSold = 0;
      let vipSalesCount = 0;
      let afterSalesCount = 0;
      
      for (const sale of approvedSales) {
        try {
          const batch = await this.batchesService.findOne(sale.eventId, sale.batchId);
          if (batch?.isVip) {
            vipTicketsSold += sale.quantity || 0;
            vipSalesCount += 1;
          }
          if (batch?.isAfter) {
            afterTicketsSold += sale.quantity || 0;
            afterSalesCount += 1;
          }
        } catch (error) {
          // Si no se puede obtener el batch, continuar sin contar
          console.warn(`No se pudo obtener batch para venta ${sale.id}:`, error);
        }
      }
      
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
            vipTickets: 0,
            vipSales: 0,
            afterTickets: 0,
            afterSales: 0,
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
        
        // Obtener batch para determinar tipo VIP/After
        try {
          const batch = await this.batchesService.findOne(eventId, sale.batchId);
          if (batch?.isVip) {
            salesByEvent[eventId].vipTickets += sale.quantity || 0;
            salesByEvent[eventId].vipSales += 1;
          }
          if (batch?.isAfter) {
            salesByEvent[eventId].afterTickets += sale.quantity || 0;
            salesByEvent[eventId].afterSales += 1;
          }
        } catch (error) {
          // Si no se puede obtener el batch, continuar sin contar
          console.warn(`No se pudo obtener batch para venta ${sale.id} en evento ${eventId}:`, error);
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
        vipTicketsSold,
        vipSalesCount,
        afterTicketsSold,
        afterSalesCount,
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
          
          // Get detailed sales table for this reseller
          const salesTable = await Promise.all(
            resellerSales.map(async (sale) => {
              let event = null;
              let batch = null;
              let buyer = null;
              
              try {
                event = await this.eventsService.findOne(sale.eventId) as any;
              } catch (e) {
                console.error(`Error obteniendo evento ${sale.eventId}:`, e);
                event = null;
              }
              
              try {
                batch = await this.batchesService.findOne(sale.eventId, sale.batchId) as any;
              } catch (e) {
                console.error(`Error obteniendo tanda ${sale.batchId}:`, e);
                batch = null;
              }
              
              try {
                buyer = await this.usersService.getUserProfile(sale.userId) as any;
              } catch (e) {
                console.error(`Error obteniendo comprador ${sale.userId}:`, e);
                buyer = null;
              }
              
              return {
                saleId: sale.id,
                date: sale.createdAt,
                eventName: event && typeof (event as any).name === 'string' ? (event as any).name : 'Unknown',
                batchName: batch && typeof (batch as any).name === 'string' ? (batch as any).name : 'Unknown',
                buyerEmail: buyer && typeof (buyer as any).email === 'string' ? (buyer as any).email : 'Unknown',
                quantity: sale.quantity,
                unitPrice: sale.basePrice || 0,
                total: sale.total || 0,
                isFree: sale.isFree || false,
                isBirthday: sale.isBirthday || false,
                birthdayPersonName: sale.birthdayPersonName || null,
                status: sale.status,
              };
            })
          );
          
          // Get sales by event for this reseller
          const salesByEvent = {};
          for (const sale of resellerSales) {
            const eventId = sale.eventId;
            if (!salesByEvent[eventId]) {
              let event = null;
              try {
                event = await this.eventsService.findOne(eventId) as any;
              } catch (e) {
                console.error(`Error obteniendo evento en salesByEvent ${eventId}:`, e);
                event = null;
              }
              salesByEvent[eventId] = {
                eventName: event && typeof (event as any).name === 'string' ? (event as any).name : 'Unknown',
                ticketsSold: 0,
                revenue: 0,
                sales: 0,
                freeTickets: 0,
                freeSales: 0,
                commission: 0, // Se calculará después
              };
            }
            salesByEvent[eventId].ticketsSold += sale.quantity || 0;
            salesByEvent[eventId].revenue += sale.total || 0;
            salesByEvent[eventId].sales += 1;
            
            if (sale.isFree === true) {
              salesByEvent[eventId].freeTickets += sale.quantity || 0;
              salesByEvent[eventId].freeSales += 1;
            }
          }

          // Calcular comisión por evento (10% del revenue de cada evento)
          let totalCommission = 0;
          for (const eventId in salesByEvent) {
            const eventRevenue = salesByEvent[eventId].revenue || 0;
            const commission = Number.isFinite(eventRevenue) && eventRevenue > 0
              ? Math.round(eventRevenue * 0.10) 
              : 0;
            salesByEvent[eventId].commission = commission;
            totalCommission += commission;
          }

          return {
            resellerId: reseller.id,
            name: `${reseller.given_name || ''} ${reseller.family_name || ''}`.trim() || reseller.email,
            email: reseller.email,
            totalSales,
            paidSalesCount,
            freeSalesCount: freeSalesCount,
            totalTicketsSold,
            paidTicketsSold,
            freeTicketsSold,
            totalRevenue,
            averageTicketPrice: Math.round(averageTicketPrice * 100) / 100,
              subtotal: Number.isFinite(totalRevenue) ? totalRevenue : 0,
              commission: totalCommission, // Suma de comisiones por evento
            salesTable, // Tabla detallada de ventas
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

  /**
   * Obtiene reporte detallado de QR Free generados
   * Incluye quién los generó y cuántos
   */
  async getFreeQRReport() {
    try {
      // Get all approved free sales
      const salesResult = await this.docClient.send(
        new ScanCommand({
          TableName: this.salesTable,
          FilterExpression: '#status = :status AND #isFree = :isFree',
          ExpressionAttributeNames: { 
            '#status': 'status',
            '#isFree': 'isFree'
          },
          ExpressionAttributeValues: { 
            ':status': 'approved',
            ':isFree': true
          },
        }),
      );
      const freeSales = salesResult.Items || [];

      // Count by creator
      const creatorStats: Record<string, any> = {};
      let totalFreeTickets = 0;
      let totalFreeSales = 0;

      for (const sale of freeSales) {
        const creatorId = sale.createdBy || sale.resellerId || 'unknown';
        const creatorEmail = sale.createdByEmail || 'unknown';
        
        if (!creatorStats[creatorId]) {
          // Get creator info
          let creatorInfo;
          try {
            creatorInfo = await this.usersService.getUserProfile(creatorId);
          } catch (error) {
            creatorInfo = { email: creatorEmail, role: 'Unknown' };
          }

          creatorStats[creatorId] = {
            creatorId,
            creatorName: creatorInfo?.given_name && creatorInfo?.family_name 
              ? `${creatorInfo.given_name} ${creatorInfo.family_name}` 
              : creatorEmail,
            creatorEmail: creatorInfo?.email || creatorEmail,
            creatorRole: creatorInfo?.role || 'Unknown',
            totalFreeTickets: 0,
            totalFreeSales: 0,
            sales: [],
          };
        }

        // Add sale to creator
        const event = await this.eventsService.findOne(sale.eventId);
        const batch = await this.batchesService.findOne(sale.eventId, sale.batchId);
        
        creatorStats[creatorId].totalFreeTickets += sale.quantity || 0;
        creatorStats[creatorId].totalFreeSales += 1;
        creatorStats[creatorId].sales.push({
          saleId: sale.id,
          date: sale.createdAt,
          eventName: event?.name || 'Unknown',
          batchName: batch?.name || 'Unknown',
          quantity: sale.quantity,
          isBirthday: sale.isBirthday || false,
          birthdayPersonName: sale.birthdayPersonName || null,
        });

        totalFreeTickets += sale.quantity || 0;
        totalFreeSales += 1;
      }

      // Convert to array and sort by total tickets descending
      const creatorStatsArray = Object.values(creatorStats).sort(
        (a: any, b: any) => b.totalFreeTickets - a.totalFreeTickets
      );

      return {
        summary: {
          totalFreeTickets,
          totalFreeSales,
          totalCreators: creatorStatsArray.length,
        },
        creators: creatorStatsArray,
      };
    } catch (error) {
      console.error('Error al generar reporte de QR Free:', error);
      throw new HttpException(
        'Error al generar reporte de QR Free',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Obtiene reporte de cumpleañeros con sus invitados
   */
  async getBirthdayReport() {
    try {
      // Get all approved free sales that are birthday sales
      const salesResult = await this.docClient.send(
        new ScanCommand({
          TableName: this.salesTable,
          FilterExpression: '#status = :status AND #isFree = :isFree AND #isBirthday = :isBirthday',
          ExpressionAttributeNames: { 
            '#status': 'status',
            '#isFree': 'isFree',
            '#isBirthday': 'isBirthday'
          },
          ExpressionAttributeValues: { 
            ':status': 'approved',
            ':isFree': true,
            ':isBirthday': true
          },
        }),
      );
      const birthdaySales = salesResult.Items || [];

      // Group by birthday person
      const birthdayStats: Record<string, any> = {};
      let totalBirthdayTickets = 0;
      let totalBirthdayPersons = 0;

      for (const sale of birthdaySales) {
        const birthdayName = sale.birthdayPersonName || 'Sin nombre';
        const key = `${birthdayName}_${sale.eventId}`;

        if (!birthdayStats[key]) {
          const event = await this.eventsService.findOne(sale.eventId);
          const batch = await this.batchesService.findOne(sale.eventId, sale.batchId);
          
          birthdayStats[key] = {
            birthdayPersonName: birthdayName,
            eventName: event?.name || 'Unknown',
            eventDate: event?.from || 'Unknown',
            batchName: batch?.name || 'Unknown',
            totalGuests: 0,
            guests: [],
          };
          totalBirthdayPersons += 1;
        }

        // Get guest info
        let guestInfo;
        try {
          guestInfo = await this.usersService.getUserProfile(sale.userId);
        } catch (error) {
          guestInfo = { email: 'Unknown' };
        }

        birthdayStats[key].totalGuests += sale.quantity;
        birthdayStats[key].guests.push({
          guestEmail: guestInfo?.email || 'Unknown',
          guestName: guestInfo?.given_name && guestInfo?.family_name
            ? `${guestInfo.given_name} ${guestInfo.family_name}`
            : guestInfo?.email || 'Unknown',
          ticketsReceived: sale.quantity,
          date: sale.createdAt,
        });

        totalBirthdayTickets += sale.quantity || 0;
      }

      // Convert to array and sort by total guests descending
      const birthdayStatsArray = Object.values(birthdayStats).sort(
        (a: any, b: any) => b.totalGuests - a.totalGuests
      );

      return {
        summary: {
          totalBirthdayPersons,
          totalBirthdayTickets,
          totalBirthdaySales: birthdaySales.length,
        },
        birthdays: birthdayStatsArray,
      };
    } catch (error) {
      console.error('Error al generar reporte de cumpleañeros:', error);
      throw new HttpException(
        'Error al generar reporte de cumpleañeros',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
