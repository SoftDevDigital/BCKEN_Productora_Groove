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
import { createCanvas, loadImage, registerFont } from 'canvas';
import * as path from 'path';
import * as fs from 'fs';

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
    isAfter?: boolean;
    isFree?: boolean;
    isBirthday?: boolean;
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
        qrImageBuffer = await this.generateVipQr(qrData, ticketId, sale.eventName);
      } else if (sale.isAfter) {
        // Generar QR After con diseño personalizado
        qrImageBuffer = await this.generateAfterQr(qrData, ticketId, sale.eventName);
      } else if (sale.isFree) {
        // Generar QR Free con diseño personalizado mejorado
        qrImageBuffer = await this.generateFreeQr(qrData, ticketId, sale.eventName, sale.isBirthday);
      } else {
        // QR normal (General) con diseño elegante
        qrImageBuffer = await this.generateNormalQr(qrData, ticketId, sale.eventName);
      }
      
      const qrKey = sale.isVip 
        ? `qrs/vip/ticket-${ticketId}-${uuidv4()}.png`
        : sale.isAfter
        ? `qrs/after/ticket-${ticketId}-${uuidv4()}.png`
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
          isAfter: sale.isAfter || false,
          qrS3Url,
          createdAt: new Date().toISOString(),
        },
      };
      await this.docClient.send(new PutCommand(params));
      tickets.push({ ticketId, saleId: sale.id, qrS3Url });
    }
    return tickets;
  }

  private async generateVipQr(
    qrData: string,
    ticketId?: string,
    eventName?: string,
  ): Promise<Buffer> {
    try {
      // Cargar la imagen de fondo desde public/qrs/qr_vip.jpg
      const backgroundImagePath = path.join(process.cwd(), 'public', 'qrs', 'qr_vip.jpg');
      
      if (!fs.existsSync(backgroundImagePath)) {
        console.error(`Imagen de fondo no encontrada en: ${backgroundImagePath}`);
        throw new Error('Imagen de fondo QR VIP no encontrada');
      }

      // Cargar imagen de fondo
      const backgroundImage = await loadImage(backgroundImagePath);
      const canvasWidth = backgroundImage.width;
      const canvasHeight = backgroundImage.height;

      // Crear canvas con las dimensiones de la imagen de fondo
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // Dibujar la imagen de fondo
      ctx.drawImage(backgroundImage, 0, 0, canvasWidth, canvasHeight);

      // Generar QR base con alta calidad
      const qrSize = Math.min(canvasWidth * 0.5, canvasHeight * 0.4);
      const qrBuffer = await QRCode.toBuffer(qrData, {
        type: 'png',
        width: Math.round(qrSize),
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'H',
      });

      // Colocar QR en el centro (donde está el espacio blanco)
      const qrX = (canvasWidth - qrSize) / 2;
      const qrY = (canvasHeight - qrSize) / 2;

      const qrImage = await loadImage(qrBuffer);
      ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

      // Agregar el ID del ticket en el rectángulo verde/amarillo de la parte inferior
      // El rectángulo está dentro de una barra marrón en la parte inferior
      // Ajustar posición para que quede exactamente en el centro del rectángulo
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // Tamaño de fuente ajustado para que encaje bien en el rectángulo
      const fontSize = Math.round(canvasWidth * 0.035);
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.fillStyle = '#ffffff'; // Color blanco para mejor visibilidad
      
      // Posición centrada horizontalmente
      const idX = canvasWidth / 2;
      // Ajuste: el rectángulo amarillo/verde está más arriba, centramos el texto en ~10% desde la parte inferior
      const idY = canvasHeight - (canvasHeight * 0.10);
      
      if (ticketId) {
        ctx.fillText(`ID: ${ticketId.toUpperCase()}`, idX, idY);
      }

      return canvas.toBuffer('image/png');
    } catch (error) {
      console.error('Error generando QR VIP con imagen de fondo:', error);
      return await QRCode.toBuffer(qrData, { type: 'png', width: 400, margin: 2 });
    }
  }

  private async generateFreeQr(
    qrData: string,
    ticketId: string,
    eventName?: string,
    isBirthday?: boolean,
  ): Promise<Buffer> {
    try {
      // Determinar qué imagen usar: cumpleaños o free normal
      const imageName = isBirthday ? 'qr_cumpleaños.jpg' : 'qr_free.jpg';
      const backgroundImagePath = path.join(process.cwd(), 'public', 'qrs', imageName);
      
      if (!fs.existsSync(backgroundImagePath)) {
        console.error(`Imagen de fondo no encontrada en: ${backgroundImagePath}`);
        throw new Error(`Imagen de fondo QR ${isBirthday ? 'Cumpleaños' : 'Free'} no encontrada`);
      }

      // Cargar imagen de fondo
      const backgroundImage = await loadImage(backgroundImagePath);
      const canvasWidth = backgroundImage.width;
      const canvasHeight = backgroundImage.height;

      // Crear canvas con las dimensiones de la imagen de fondo
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // Dibujar la imagen de fondo
      ctx.drawImage(backgroundImage, 0, 0, canvasWidth, canvasHeight);

      // Generar QR base con alta calidad
      // Ajustar tamaño del QR para que encaje en el espacio blanco central
      // El espacio blanco parece estar en el centro, usar aproximadamente 60% del ancho de la imagen
      const qrSize = Math.min(canvasWidth * 0.5, canvasHeight * 0.4);
      const qrBuffer = await QRCode.toBuffer(qrData, {
        type: 'png',
        width: Math.round(qrSize),
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'H',
      });

      // Colocar QR en el centro (donde está el espacio blanco)
      const qrX = (canvasWidth - qrSize) / 2;
      const qrY = (canvasHeight - qrSize) / 2;

      const qrImage = await loadImage(qrBuffer);
      ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

      // Agregar el ID del ticket en el rectángulo verde/amarillo de la parte inferior
      // El rectángulo está dentro de una barra marrón en la parte inferior
      // Ajustar posición para que quede exactamente en el centro del rectángulo
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // Tamaño de fuente ajustado para que encaje bien en el rectángulo
      const fontSize = Math.round(canvasWidth * 0.035);
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.fillStyle = '#ffffff'; // Color blanco para mejor visibilidad
      
      // Posición centrada horizontalmente
      const idX = canvasWidth / 2;
      // Ajuste: el rectángulo amarillo/verde está más arriba, centramos el texto en ~10% desde la parte inferior
      const idY = canvasHeight - (canvasHeight * 0.10);
      
      // Dibujar el ID del ticket con prefijo "ID: "
      ctx.fillText(`ID: ${ticketId.toUpperCase()}`, idX, idY);

      // Retornar la imagen combinada como PNG
      return canvas.toBuffer('image/png');
    } catch (error) {
      console.error('Error generando QR Free con imagen de fondo:', error);
      // Fallback: generar QR simple si falla
      return await QRCode.toBuffer(qrData, { type: 'png', width: 400, margin: 2 });
    }
  }

  private async generateAfterQr(
    qrData: string,
    ticketId: string,
    eventName?: string,
  ): Promise<Buffer> {
    try {
      console.log('🎨 Generando QR After con textos:', { ticketId, eventName: eventName || 'NO PROPORCIONADO' });
      
      // Generar QR base con alta calidad
      const qrSize = 300;
      const qrBuffer = await QRCode.toBuffer(qrData, {
        type: 'png',
        width: qrSize,
        margin: 2,
        color: {
          dark: '#1a0d2e',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'H',
      });

      // Dimensiones del poster After
      const canvasWidth = 600;
      const canvasHeight = 800;

      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // Configurar contexto de texto
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      // === FONDO CON GRADIENTE MORADO/VIOLETA NOCTURNO ===
      const gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
      gradient.addColorStop(0, '#2d1b4e'); // Morado oscuro en la parte superior
      gradient.addColorStop(0.5, '#4a2c6b'); // Morado medio
      gradient.addColorStop(1, '#1a0d2e'); // Morado muy oscuro en la parte inferior

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // === QR CENTRADO ===
      const qrX = (canvasWidth - qrSize) / 2;
      const qrY = (canvasHeight - qrSize) / 2;

      // Fondo circular blanco para el QR
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(canvasWidth / 2, canvasHeight / 2, qrSize / 2 + 20, 0, Math.PI * 2);
      ctx.fill();

      // Sombra del QR
      ctx.shadowColor = 'rgba(139, 92, 246, 0.4)';
      ctx.shadowBlur = 20;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 5;

      const qrImage = await loadImage(qrBuffer);
      ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

      // Resetear sombra
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // === ELEMENTOS DECORATIVOS NOCTURNOS (primero los decorativos) ===
      this.drawAfterElements(ctx, canvasWidth, canvasHeight);

      // === ESTRELLAS FLOTANTES ===
      this.drawStars(ctx, canvasWidth, canvasHeight);

      // === TEXTO PROFESIONAL (después de los decorativos para que quede encima) ===
      // IMPORTANTE: Dibujar textos DESPUÉS del QR y decorativos
      
      const displayEventName = eventName || 'EVENTO';
      
      // Resetear configuración de texto
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
      
      // 1. FONDO Y NOMBRE DEL EVENTO (parte superior)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(20, 30, canvasWidth - 40, 60);
      
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 26px Arial, sans-serif';
      ctx.shadowColor = 'rgba(167, 139, 250, 1)';
      ctx.shadowBlur = 12;
      const eventText = displayEventName.length > 26 ? displayEventName.substring(0, 23) + '...' : displayEventName;
      ctx.fillText(eventText.toUpperCase(), canvasWidth / 2, 50);
      ctx.shadowBlur = 0;
      console.log('✅ Texto evento dibujado:', eventText);

      // 2. FONDO Y TEXTO "AFTER" (muy grande y visible)
      ctx.fillStyle = 'rgba(139, 92, 246, 0.5)';
      ctx.fillRect(canvasWidth / 2 - 140, 105, 280, 60);
      
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 52px Arial, sans-serif';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 15;
      ctx.fillText('AFTER', canvasWidth / 2, 115);
      ctx.shadowBlur = 0;
      console.log('✅ Texto AFTER dibujado');

      // 3. FONDO Y TICKET ID (parte inferior)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(20, canvasHeight - 110, canvasWidth - 40, 80);
      
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 22px Arial, sans-serif';
      ctx.shadowColor = 'rgba(196, 181, 253, 1)';
      ctx.shadowBlur = 8;
      const idText = `ID: ${ticketId.toUpperCase()}`;
      ctx.fillText(idText, canvasWidth / 2, canvasHeight - 80);
      ctx.shadowBlur = 0;
      console.log('✅ Texto ID dibujado:', idText);

      // 4. FEST-GO branding
      ctx.fillStyle = '#c4b5fd';
      ctx.font = 'bold 20px Arial, sans-serif';
      ctx.shadowColor = 'rgba(139, 92, 246, 0.8)';
      ctx.shadowBlur = 6;
      ctx.fillText('FEST-GO', canvasWidth / 2, canvasHeight - 40);
      ctx.shadowBlur = 0;
      console.log('✅ Texto FEST-GO dibujado');
      
      console.log('✅ QR After generado exitosamente con todos los textos');

      return canvas.toBuffer('image/png');
    } catch (error) {
      console.error('Error generando QR After, usando QR normal:', error);
      return await QRCode.toBuffer(qrData, { type: 'png', width: 400, margin: 2 });
    }
  }

  // === FUNCIONES AUXILIARES PARA DISEÑO AFTER ===
  
  private drawAfterElements(ctx: any, canvasWidth: number, canvasHeight: number) {
    const centerY = canvasHeight / 2;
    
    // Líneas decorativas en los costados con efecto neón morado
    const neonColors = ['#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe'];
    
    // Lado izquierdo
    for (let i = 0; i < 6; i++) {
      const y = centerY - 150 + (i * 50);
      const color = neonColors[i % neonColors.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.6;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      
      ctx.beginPath();
      ctx.moveTo(30, y);
      ctx.lineTo(80, y);
      ctx.stroke();
      
      ctx.shadowBlur = 0;
    }
    
    // Lado derecho
    for (let i = 0; i < 6; i++) {
      const y = centerY - 150 + (i * 50);
      const color = neonColors[i % neonColors.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.6;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      
      ctx.beginPath();
      ctx.moveTo(canvasWidth - 80, y);
      ctx.lineTo(canvasWidth - 30, y);
      ctx.stroke();
      
      ctx.shadowBlur = 0;
    }
    
    ctx.globalAlpha = 1;
  }
  
  private drawStars(ctx: any, canvasWidth: number, canvasHeight: number) {
    const starPositions = [
      { x: 100, y: 120 }, { x: 500, y: 140 }, { x: 120, y: 680 },
      { x: 480, y: 660 }, { x: 70, y: 350 }, { x: 530, y: 380 },
      { x: 180, y: 90 }, { x: 420, y: 710 }
    ];
    
    ctx.fillStyle = '#c4b5fd';
    ctx.globalAlpha = 0.8;
    
    for (const pos of starPositions) {
      ctx.shadowColor = '#8b5cf6';
      ctx.shadowBlur = 10;
      
      // Dibujar estrella simple (cruz con punto)
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y - 5);
      ctx.lineTo(pos.x, pos.y + 5);
      ctx.moveTo(pos.x - 5, pos.y);
      ctx.lineTo(pos.x + 5, pos.y);
      ctx.strokeStyle = '#c4b5fd';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Punto central
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 2, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.shadowBlur = 0;
    }
    
    ctx.globalAlpha = 1;
  }

  // === FUNCIONES AUXILIARES PARA DISEÑO MUSICAL ===
  
  private drawMusicalElements(ctx: any, side: 'left' | 'right', canvasWidth: number, canvasHeight: number) {
    const x = side === 'left' ? 60 : canvasWidth - 60;
    const centerY = canvasHeight / 2;
    
    // Notas musicales en vertical
    const noteColors = ['#60a5fa', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    const noteSymbols = ['♪', '♫', '♬', '♩', '♭', '♯'];
    
    for (let i = 0; i < 8; i++) {
      const y = centerY - 200 + (i * 50);
      const color = noteColors[i % noteColors.length];
      const symbol = noteSymbols[i % noteSymbols.length];
      const size = 20 + Math.sin(i * 0.5) * 8;
      
      ctx.fillStyle = color;
      ctx.font = `${size}px Arial, sans-serif`;
      ctx.fillText(symbol, x, y);
      
      // Efecto de brillo
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillText(symbol, x, y);
      ctx.shadowBlur = 0;
    }
    
    // Líneas de pentagrama estilizadas
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.3)';
    ctx.lineWidth = 2;
    const lineStart = side === 'left' ? 20 : canvasWidth - 120;
    const lineEnd = side === 'left' ? 100 : canvasWidth - 20;
    
    for (let i = 0; i < 5; i++) {
      const y = centerY - 60 + (i * 15);
      ctx.beginPath();
      ctx.moveTo(lineStart, y);
      ctx.lineTo(lineEnd, y);
      ctx.stroke();
    }
  }
  
  private drawSoundWaves(ctx: any, centerX: number, centerY: number, width: number, color: string, opacity: number) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 3;
    
    // Ondas de sonido concéntricas
    for (let i = 0; i < 5; i++) {
      const radius = 30 + (i * 20);
      ctx.beginPath();
      
      // Onda superior
      ctx.arc(centerX, centerY, radius, Math.PI, 2 * Math.PI);
      ctx.stroke();
      
      // Onda inferior (si hay espacio)
      if (centerY > 200) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI);
        ctx.stroke();
      }
    }
    
    ctx.globalAlpha = 1;
  }
  
  private drawFloatingNotes(ctx: any, canvasWidth: number, canvasHeight: number) {
    const notePositions = [
      { x: 100, y: 150 }, { x: 500, y: 180 }, { x: 150, y: 650 },
      { x: 450, y: 620 }, { x: 80, y: 400 }, { x: 520, y: 450 },
      { x: 200, y: 100 }, { x: 400, y: 700 }
    ];
    
    const noteSymbols = ['♪', '♫', '♬', '♩'];
    const noteColors = ['#60a5fa', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    
    for (const [index, pos] of notePositions.entries()) {
      const symbol = noteSymbols[index % noteSymbols.length];
      const color = noteColors[index % noteColors.length];
      const size = 16 + Math.sin(index) * 6;
      
      ctx.fillStyle = color;
      ctx.font = `${size}px Arial, sans-serif`;
      ctx.globalAlpha = 0.7;
      
      // Efecto de resplandor
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fillText(symbol, pos.x, pos.y);
      
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
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

  private async generateNormalQr(
    qrData: string,
    ticketId: string,
    eventName?: string,
  ): Promise<Buffer> {
    try {
      // Cargar la imagen de fondo desde public/qrs/qr_general.jpg
      const backgroundImagePath = path.join(process.cwd(), 'public', 'qrs', 'qr_general.jpg');
      
      if (!fs.existsSync(backgroundImagePath)) {
        console.error(`Imagen de fondo no encontrada en: ${backgroundImagePath}`);
        throw new Error('Imagen de fondo QR General no encontrada');
      }

      // Cargar imagen de fondo
      const backgroundImage = await loadImage(backgroundImagePath);
      const canvasWidth = backgroundImage.width;
      const canvasHeight = backgroundImage.height;

      // Crear canvas con las dimensiones de la imagen de fondo
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // Dibujar la imagen de fondo
      ctx.drawImage(backgroundImage, 0, 0, canvasWidth, canvasHeight);

      // Generar QR base con alta calidad
      const qrSize = Math.min(canvasWidth * 0.5, canvasHeight * 0.4);
      const qrBuffer = await QRCode.toBuffer(qrData, {
        type: 'png',
        width: Math.round(qrSize),
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'H',
      });

      // Colocar QR en el centro (donde está el espacio blanco)
      const qrX = (canvasWidth - qrSize) / 2;
      const qrY = (canvasHeight - qrSize) / 2;

      const qrImage = await loadImage(qrBuffer);
      ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

      // Agregar el ID del ticket en el rectángulo verde/amarillo de la parte inferior
      // El rectángulo está dentro de una barra marrón en la parte inferior
      // Ajustar posición para que quede exactamente en el centro del rectángulo
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // Tamaño de fuente ajustado para que encaje bien en el rectángulo
      const fontSize = Math.round(canvasWidth * 0.035);
      ctx.font = `bold ${fontSize}px Arial, sans-serif`;
      ctx.fillStyle = '#ffffff'; // Color blanco para mejor visibilidad
      
      // Posición centrada horizontalmente
      const idX = canvasWidth / 2;
      // El rectángulo verde/amarillo está más arriba, aproximadamente a 5-6% desde la parte inferior
      // Subir el ID para que quede dentro del rectángulo señalado
      const idY = canvasHeight - (canvasHeight * 0.055);
      
      ctx.fillText(`ID: ${ticketId.toUpperCase()}`, idX, idY);

      return canvas.toBuffer('image/png');
    } catch (error) {
      console.error('Error generando QR General con imagen de fondo:', error);
      return await QRCode.toBuffer(qrData, { type: 'png', width: 400, margin: 2 });
    }
  }

  // === FUNCIONES AUXILIARES PARA DISEÑO VIP ===
  
  private drawGoldTexture(ctx: any, canvasWidth: number, canvasHeight: number) {
    // Crear patrón de textura dorada
    ctx.globalAlpha = 0.3;
    
    for (let i = 0; i < 50; i++) {
      const x = Math.random() * canvasWidth;
      const y = Math.random() * canvasHeight;
      const size = Math.random() * 4 + 1;
      
      ctx.fillStyle = '#ffeb3b';
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    
    ctx.globalAlpha = 1;
  }
  
  private drawVipElements(ctx: any, canvasWidth: number, canvasHeight: number) {
    const centerY = canvasHeight / 2;
    
    // Elementos VIP a los lados
    const vipSymbols = ['👑', '💎', '⭐', '🏆', '💰'];
    const goldColors = ['#ffd700', '#ffb347', '#daa520', '#b8860b'];
    
    for (let side of ['left', 'right']) {
      const x = side === 'left' ? 60 : canvasWidth - 60;
      
      for (let i = 0; i < 6; i++) {
        const y = centerY - 150 + (i * 50);
        const symbol = vipSymbols[i % vipSymbols.length];
        const color = goldColors[i % goldColors.length];
        const size = 24 + Math.sin(i * 0.7) * 6;
        
        ctx.fillStyle = color;
        ctx.font = `${size}px Arial, sans-serif`;
        ctx.fillText(symbol, x, y);
        
        // Efecto dorado brillante
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fillText(symbol, x, y);
        ctx.shadowBlur = 0;
      }
    }
  }
  
  private drawVipCrown(ctx: any, centerX: number, centerY: number) {
    // Dibujar corona VIP
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 48px Arial, sans-serif';
    
    // Sombra de la corona
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    
    ctx.fillText('👑', centerX, centerY);
    
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  
  private drawGoldParticles(ctx: any, canvasWidth: number, canvasHeight: number) {
    const particles = [
      { x: 80, y: 120 }, { x: 520, y: 150 }, { x: 100, y: 680 },
      { x: 500, y: 650 }, { x: 60, y: 400 }, { x: 540, y: 450 },
      { x: 150, y: 200 }, { x: 450, y: 600 }, { x: 300, y: 120 }, { x: 300, y: 680 }
    ];
    
    const goldSymbols = ['✨', '💫', '⭐', '🌟'];
    const goldColors = ['#ffd700', '#ffb347', '#daa520'];
    
    for (const [index, pos] of particles.entries()) {
      const symbol = goldSymbols[index % goldSymbols.length];
      const color = goldColors[index % goldColors.length];
      const size = 14 + Math.sin(index) * 4;
      
      ctx.fillStyle = color;
      ctx.font = `${size}px Arial, sans-serif`;
      ctx.globalAlpha = 0.8;
      
      // Efecto brillante
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillText(symbol, pos.x, pos.y);
      
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }
  
  // === FUNCIONES AUXILIARES PARA DISEÑO NORMAL/CORPORATIVO ===
  
  private drawCorporateElements(ctx: any, canvasWidth: number, canvasHeight: number) {
    const centerY = canvasHeight / 2;
    
    // Elementos corporativos a los lados
    const corporateSymbols = ['🎫', '🎪', '🎭', '🎨', '🎵', '🎤'];
    const blueColors = ['#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8'];
    
    for (let side of ['left', 'right']) {
      const x = side === 'left' ? 60 : canvasWidth - 60;
      
      for (let i = 0; i < 6; i++) {
        const y = centerY - 150 + (i * 50);
        const symbol = corporateSymbols[i % corporateSymbols.length];
        const color = blueColors[i % blueColors.length];
        const size = 20 + Math.sin(i * 0.5) * 4;
        
        ctx.fillStyle = color;
        ctx.font = `${size}px Arial, sans-serif`;
        ctx.fillText(symbol, x, y);
        
        // Efecto azul brillante
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.fillText(symbol, x, y);
        ctx.shadowBlur = 0;
      }
    }
  }
  
  private drawCorporateWaves(ctx: any, centerX: number, centerY: number, color: string, opacity: number) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 4;
    
    // Ondas corporativas más geométricas
    for (let i = 0; i < 4; i++) {
      const radius = 40 + (i * 25);
      ctx.beginPath();
      
      // Forma hexagonal/corporativa
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 3) {
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius * 0.6;
        
        if (angle === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.stroke();
    }
    
    ctx.globalAlpha = 1;
  }
  
  private drawCorporateParticles(ctx: any, canvasWidth: number, canvasHeight: number) {
    const particles = [
      { x: 100, y: 160 }, { x: 500, y: 190 }, { x: 120, y: 640 },
      { x: 480, y: 610 }, { x: 80, y: 380 }, { x: 520, y: 420 },
      { x: 180, y: 120 }, { x: 420, y: 680 }
    ];
    
    const corporateSymbols = ['▲', '●', '◆', '■'];
    const blueColors = ['#60a5fa', '#3b82f6', '#2563eb'];
    
    for (const [index, pos] of particles.entries()) {
      const symbol = corporateSymbols[index % corporateSymbols.length];
      const color = blueColors[index % blueColors.length];
      const size = 12 + Math.sin(index) * 3;
      
      ctx.fillStyle = color;
      ctx.font = `${size}px Arial, sans-serif`;
      ctx.globalAlpha = 0.7;
      
      // Efecto corporativo
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.fillText(symbol, pos.x, pos.y);
      
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
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
      isAfter?: boolean;
      ticket?: any;
    }> = [];
    const scanRecords: Array<{
      id: string;
      ticketId: string;
      status: string;
      scannedAt: string;
      isVip?: boolean;
      isAfter?: boolean;
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
          // Agregar isVip e isAfter al registro de escaneo para poder filtrar después
          if (ticket) {
            scanRecord.isVip = ticket.isVip || false;
            scanRecord.isAfter = ticket.isAfter || false;
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
          isAfter: ticket.isAfter || false, // Agregar propiedad isAfter para el frontend
          ticket: {
            ticketId: ticket.id,
            saleId: ticket.saleId,
            userId: ticket.userId,
            eventId: ticket.eventId,
            batchId: ticket.batchId,
            status: 'used',
            qrS3Url: ticket.qrS3Url,
            isVip: ticket.isVip || false,
            isAfter: ticket.isAfter || false,
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
