import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { nanoid } from 'nanoid';
import * as QRCode from 'qrcode';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { createCanvas, loadImage } from 'canvas';

@Injectable()
export class TicketsService {
  private readonly tableName = 'Tickets-v2';
  private readonly scansTableName = 'TicketScans-v2';
  private readonly docClient: DynamoDBDocumentClient;
  private readonly s3Client: S3Client;

  constructor(
    @Inject('DYNAMODB_CLIENT') private readonly dynamoDbClient: DynamoDBClient,
    private configService: ConfigService,
  ) {
    this.docClient = DynamoDBDocumentClient.from(dynamoDbClient);
    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION'),
    });
  }

  async createTickets(sale: {
    id: string;
    userId: string;
    eventId: string;
    batchId: string;
    quantity: number;
    isVip?: boolean;
    isFree?: boolean;
    eventName?: string;
  }) {
    const tickets: Array<{
      ticketId: string;
      saleId: string;
      qrS3Url: string;
    }> = [];
    const bucket =
      this.configService.get<string>('S3_BUCKET') || 'ticket-qr-bucket-dev-v2';
    for (let i = 0; i < sale.quantity; i++) {
      const ticketId = nanoid(6);
      const qrData = `ticketId:${ticketId}`;
      
      let qrImageBuffer: Buffer;
      
      if (sale.isVip) {
        // Generar QR VIP con diseño personalizado
        qrImageBuffer = await this.generateVipQr(qrData);
      } else if (sale.isFree) {
        // Generar QR Free con diseño personalizado mejorado
        qrImageBuffer = await this.generateFreeQr(qrData, ticketId, sale.eventName);
      } else {
        // QR normal
        qrImageBuffer = await QRCode.toBuffer(qrData, { 
          type: 'png',
          width: 512,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF',
          },
        });
      }
      
      const qrKey = sale.isVip 
        ? `qrs/vip/ticket-${ticketId}-${uuidv4()}.png`
        : sale.isFree
        ? `qrs/free/ticket-${ticketId}-${uuidv4()}.png`
        : `qrs/ticket-${ticketId}-${uuidv4()}.png`;
      
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: qrKey,
          Body: qrImageBuffer,
          ContentType: 'image/png',
        }),
      );
      const qrS3Url = `https://${bucket}.s3.amazonaws.com/${qrKey}`;
      const params = {
        TableName: this.tableName,
        Item: {
          id: ticketId,
          saleId: sale.id,
          userId: sale.userId,
          eventId: sale.eventId,
          batchId: sale.batchId,
          status: 'active',
          isVip: sale.isVip || false,
          qrS3Url,
          createdAt: new Date().toISOString(),
        },
      };
      await this.docClient.send(new PutCommand(params));
      tickets.push({ ticketId, saleId: sale.id, qrS3Url });
    }
    return tickets;
  }

  private async generateVipQr(qrData: string): Promise<Buffer> {
    try {
      // Generar QR base con colores dorado y negro
      const qrBuffer = await QRCode.toBuffer(qrData, {
        type: 'png',
        width: 600,
        margin: 2,
        color: {
          dark: '#000000', // Negro para el QR
          light: '#FFFFFF', // Blanco de fondo
        },
        errorCorrectionLevel: 'H', // Alto nivel de corrección
      });

      // Crear canvas para agregar diseño VIP
      const padding = 40;
      const vipTextHeight = 50;
      const borderWidth = 6;
      const canvasWidth = 600 + (padding * 2);
      const canvasHeight = 600 + (padding * 2) + vipTextHeight;

      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // Fondo degradado dorado
      const gradient = ctx.createLinearGradient(0, 0, canvasWidth, canvasHeight);
      gradient.addColorStop(0, '#FFD700'); // Dorado
      gradient.addColorStop(0.5, '#FFA500'); // Naranja dorado
      gradient.addColorStop(1, '#FFD700'); // Dorado
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // Borde decorativo externo
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = borderWidth;
      ctx.strokeRect(
        borderWidth / 2,
        borderWidth / 2,
        canvasWidth - borderWidth,
        canvasHeight - borderWidth,
      );

      // Borde interno dorado
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 3;
      ctx.strokeRect(
        borderWidth + 5,
        borderWidth + 5,
        canvasWidth - (borderWidth * 2) - 10,
        canvasHeight - (borderWidth * 2) - 10,
      );

      // Cargar QR como imagen
      const qrImage = await loadImage(qrBuffer);
      
      // Agregar QR en el centro
      const qrX = padding;
      const qrY = padding;
      ctx.drawImage(qrImage, qrX, qrY, 600, 600);

      // Agregar texto "VIP" arriba del QR
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 48px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // Sombra del texto
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 3;
      
      ctx.fillText('VIP', canvasWidth / 2, padding / 2);
      
      // Resetear sombra
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // Agregar texto "VIP" abajo del QR con diseño decorativo
      const bottomTextY = padding + 600 + (vipTextHeight / 2);
      
      // Fondo para el texto inferior
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(
        padding + 100,
        bottomTextY - 25,
        400,
        50,
      );
      
      // Texto VIP inferior
      ctx.fillStyle = '#FFD700';
      ctx.font = 'bold 36px Arial';
      ctx.fillText('VIP TICKET', canvasWidth / 2, bottomTextY);

      // Convertir canvas a buffer
      return canvas.toBuffer('image/png');
    } catch (error) {
      console.error('Error generando QR VIP, usando QR normal:', error);
      // Fallback a QR normal si hay error
      return await QRCode.toBuffer(qrData, {
        type: 'png',
        width: 512,
        margin: 2,
      });
    }
  }

  private async generateFreeQr(
    qrData: string,
    ticketId: string,
    eventName?: string,
  ): Promise<Buffer> {
    try {
      // Generar QR base - alta calidad
      const qrSize = 800;
      const qrBuffer = await QRCode.toBuffer(qrData, {
        type: 'png',
        width: qrSize,
        margin: 4,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
        errorCorrectionLevel: 'H',
      });

      // Dimensiones del canvas con diseño atractivo
      const topBannerHeight = 120;
      const bottomAreaHeight = 140;
      const sideMargin = 80;
      const qrAreaPadding = 60;
      
      const canvasWidth = qrSize + (sideMargin * 2);
      const canvasHeight = topBannerHeight + qrSize + (qrAreaPadding * 2) + bottomAreaHeight;

      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // === FONDO PRINCIPAL ===
      // Gradiente de fondo elegante
      const bgGradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
      bgGradient.addColorStop(0, '#f8fafc'); // Gris muy claro arriba
      bgGradient.addColorStop(0.3, '#ffffff'); // Blanco en el medio
      bgGradient.addColorStop(1, '#f1f5f9'); // Gris suave abajo
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // === BANNER SUPERIOR ===
      // Gradiente del banner (atractivo y moderno)
      const bannerGradient = ctx.createLinearGradient(0, 0, canvasWidth, topBannerHeight);
      bannerGradient.addColorStop(0, '#8b5cf6'); // Púrpura vibrante
      bannerGradient.addColorStop(0.5, '#a855f7'); // Púrpura medio
      bannerGradient.addColorStop(1, '#7c3aed'); // Púrpura oscuro
      ctx.fillStyle = bannerGradient;
      ctx.fillRect(0, 0, canvasWidth, topBannerHeight);

      // Elementos decorativos en el banner
      // Círculos decorativos
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.arc(60, 30, 25, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(canvasWidth - 60, 30, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(canvasWidth - 40, 90, 15, 0, Math.PI * 2);
      ctx.fill();

      // Texto "ENTRADA GRATUITA" en el banner
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 36px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // Sombra del texto principal
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
      
      ctx.fillText('🎫 ENTRADA GRATUITA', canvasWidth / 2, 45);
      
      // Subtítulo del evento
      if (eventName) {
        ctx.font = 'bold 24px Arial';
        ctx.fillStyle = '#e0e7ff'; // Púrpura muy claro
        this.wrapAndFillText(ctx, eventName, canvasWidth / 2, 85, canvasWidth - 40, 26);
      } else {
        ctx.font = '20px Arial';
        ctx.fillStyle = '#e0e7ff';
        ctx.fillText('FEST-GO EVENT', canvasWidth / 2, 85);
      }

      // Resetear sombra
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // === ÁREA DEL QR ===
      const qrStartY = topBannerHeight + qrAreaPadding;
      
      // Contenedor del QR con sombra elegante
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
      ctx.shadowBlur = 20;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 10;
      
      // Contenedor redondeado para el QR
      this.roundRect(ctx, sideMargin - 20, qrStartY - 20, qrSize + 40, qrSize + 40, 15);
      ctx.fill();
      
      // Resetear sombra
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // Marco decorativo alrededor del QR
      const frameGradient = ctx.createLinearGradient(0, qrStartY, 0, qrStartY + qrSize);
      frameGradient.addColorStop(0, '#8b5cf6');
      frameGradient.addColorStop(1, '#7c3aed');
      ctx.strokeStyle = frameGradient;
      ctx.lineWidth = 4;
      this.roundRect(ctx, sideMargin - 15, qrStartY - 15, qrSize + 30, qrSize + 30, 12);
      ctx.stroke();

      // Dibujar el QR centrado
      const qrImage = await loadImage(qrBuffer);
      ctx.drawImage(qrImage, sideMargin, qrStartY, qrSize, qrSize);

      // === ÁREA INFERIOR ===
      const bottomStartY = qrStartY + qrSize + 40;
      
      // Fondo del área inferior con gradiente sutil
      const bottomGradient = ctx.createLinearGradient(0, bottomStartY, 0, bottomStartY + bottomAreaHeight);
      bottomGradient.addColorStop(0, 'rgba(139, 92, 246, 0.05)');
      bottomGradient.addColorStop(1, 'rgba(124, 58, 237, 0.1)');
      ctx.fillStyle = bottomGradient;
      this.roundRect(ctx, 20, bottomStartY - 10, canvasWidth - 40, bottomAreaHeight - 20, 10);
      ctx.fill();

      // ID del ticket con estilo atractivo
      const cleanTicketId = ticketId
        .toUpperCase()
        .split('')
        .filter((c) => /[A-Z0-9]/.test(c))
        .join('');

      // Etiqueta "CÓDIGO DE ENTRADA"
      ctx.fillStyle = '#6b7280';
      ctx.font = 'bold 16px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('CÓDIGO DE ENTRADA', canvasWidth / 2, bottomStartY + 25);

      // ID del ticket principal
      ctx.fillStyle = '#111827';
      ctx.font = 'bold 48px "Courier New", Courier, monospace';
      ctx.fillText(cleanTicketId, canvasWidth / 2, bottomStartY + 70);

      // Línea decorativa
      ctx.strokeStyle = '#d1d5db';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(canvasWidth * 0.25, bottomStartY + 90);
      ctx.lineTo(canvasWidth * 0.75, bottomStartY + 90);
      ctx.stroke();

      // Marca y mensaje final
      ctx.fillStyle = '#8b5cf6';
      ctx.font = 'bold 20px Arial';
      ctx.fillText('FEST-GO', canvasWidth / 2, bottomStartY + 115);
      
      ctx.fillStyle = '#6b7280';
      ctx.font = '14px Arial';
      ctx.fillText('¡Presenta este código en el evento!', canvasWidth / 2, bottomStartY + 135);

      return canvas.toBuffer('image/png');
    } catch (error) {
      console.error('Error generando QR Free, usando QR normal:', error);
      return await QRCode.toBuffer(qrData, { type: 'png', width: 512, margin: 2 });
    }
  }

  // Función auxiliar para dibujar rectángulos redondeados
  private roundRect(ctx: any, x: number, y: number, width: number, height: number, radius: number) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  async validateTicket(ticketId: string) {
    const params = {
      TableName: this.tableName,
      Key: { id: ticketId },
    };
    try {
      const result = await this.docClient.send(new GetCommand(params));
      if (!result.Item || result.Item.status !== 'active') {
        throw new HttpException(
          'Ticket no válido o inactivo',
          HttpStatus.BAD_REQUEST,
        );
      }
      return result.Item;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al validar ticket',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async scanTickets(ticketIds: string[]) {
    const results: Array<{
      ticketId: string;
      status: 'valid' | 'invalid';
      message: string;
      isVip?: boolean;
      ticket?: any;
    }> = [];
    const scanRecords: Array<{
      id: string;
      ticketId: string;
      status: string;
      scannedAt: string;
    }> = [];

    for (const ticketId of ticketIds) {
      try {
        const ticket = await this.validateTicket(ticketId);
        await this.docClient.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { id: ticketId },
            UpdateExpression: 'SET #status = :status, #usedAt = :usedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#usedAt': 'usedAt',
            },
            ExpressionAttributeValues: {
              ':status': 'used',
              ':usedAt': new Date().toISOString(),
            },
          }),
        );
        const scanId = nanoid(10);
        // Agregar eventId al registro de escaneo para poder contar por evento
        // Mantener compatibilidad: eventId es opcional
        const scanRecord: any = {
          id: scanId,
          ticketId,
          status: 'valid',
          scannedAt: new Date().toISOString(),
        };
        // Solo agregar eventId si el ticket lo tiene (siempre debería tenerlo)
        // Manejo seguro para evitar errores si eventId no existe
        try {
          if (ticket && ticket.eventId) {
            scanRecord.eventId = ticket.eventId;
          }
        } catch (eventIdError: any) {
          console.error(`Error al obtener eventId del ticket ${ticketId}:`, eventIdError.message);
          // Continuar sin eventId, no es crítico para el escaneo
        }
        scanRecords.push(scanRecord);
        results.push({
          ticketId,
          status: 'valid',
          message: 'Ticket válido y marcado como usado',
          isVip: ticket.isVip || false, // Agregar propiedad isVip para el frontend
          ticket: {
            ticketId: ticket.id,
            saleId: ticket.saleId,
            userId: ticket.userId,
            eventId: ticket.eventId,
            batchId: ticket.batchId,
            status: 'used',
            qrS3Url: ticket.qrS3Url,
            isVip: ticket.isVip || false,
          },
        });
      } catch (error) {
        const scanId = nanoid(10);
        scanRecords.push({
          id: scanId,
          ticketId,
          status: 'invalid',
          scannedAt: new Date().toISOString(),
        });
        results.push({
          ticketId,
          status: 'invalid',
          message: error.message || 'Ticket no válido o inactivo',
        });
      }
    }

    // Guardar escaneos con manejo de errores individual para que no se detenga el proceso
    for (const scan of scanRecords) {
      try {
        await this.docClient.send(
          new PutCommand({
            TableName: this.scansTableName,
            Item: scan,
          }),
        );
      } catch (scanSaveError: any) {
        console.error(`Error al guardar escaneo para ticket ${scan.ticketId}:`, scanSaveError.message);
        // Continuar con los demás escaneos aunque falle uno
        // No lanzar error para no romper el flujo
      }
    }

    return results;
  }

  /**
   * Obtiene el conteo de tickets escaneados (válidos) por evento
   * Método nuevo que no afecta la lógica existente
   */
  async getScansCountByEvent(eventId: string): Promise<number> {
    try {
      const result = await this.docClient.send(
        new ScanCommand({
          TableName: this.scansTableName,
          FilterExpression: 'eventId = :eventId AND #status = :status',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':eventId': eventId,
            ':status': 'valid',
          },
        }),
      );
      return (result.Items || []).length;
    } catch (error) {
      console.error('Error al contar escaneos por evento:', error);
      // Retornar 0 si hay error para no romper nada
      return 0;
    }
  }

  /**
   * Obtiene el conteo total de tickets escaneados (válidos) para todos los eventos
   * Método nuevo que no afecta la lógica existente
   */
  async getTotalScansCount(): Promise<number> {
    try {
      const result = await this.docClient.send(
        new ScanCommand({
          TableName: this.scansTableName,
          FilterExpression: '#status = :status',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': 'valid',
          },
        }),
      );
      return (result.Items || []).length;
    } catch (error) {
      console.error('Error al contar total de escaneos:', error);
      // Retornar 0 si hay error para no romper nada
      return 0;
    }
  }

  private wrapAndFillText(ctx: any, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
    // Simple word-wrap and fill centered lines around y
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const w of words) {
      const test = current ? `${current} ${w}` : w;
      const metrics = ctx.measureText(test);
      if (metrics.width > maxWidth && current) {
        lines.push(current);
        current = w;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);

    const startY = y - ((lines.length - 1) * lineHeight) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, startY + i * lineHeight);
    }
  }
}
