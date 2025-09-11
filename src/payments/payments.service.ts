import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import { CreateQrDto } from './dto/create-qr.dto';
import * as QRCode from 'qrcode';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PaymentsService {
  private client: MercadoPagoConfig;
  private s3Client: S3Client;

  constructor(private configService: ConfigService) {
    const accessToken =
      'APP_USR-8581189409054279-091018-c6d03928f1a9466fb3fbc1cdbcf80512-2369426390';
    if (!accessToken) {
      throw new BadRequestException(
        'MERCADO_PAGO_ACCESS_TOKEN is not defined in environment variables',
      );
    }
    this.client = new MercadoPagoConfig({ accessToken });
    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION'),
    });
  }

  async generateQr(dto: CreateQrDto, saleId: string): Promise<any> {
    const preference = new Preference(this.client);
    const preferenceData = {
      items: [
        {
          id: `sale-${saleId}`,
          title: dto.title,
          unit_price: dto.amount,
          quantity: 1,
          currency_id: 'ARS',
        },
      ],
      payment_methods: {
        excluded_payment_methods: [],
        excluded_payment_types: [],
        installments: 1,
      },
      back_urls: {
        success: `${this.configService.get<string>('API_BASE_URL')}/payments/success`,
        failure: `${this.configService.get<string>('API_BASE_URL')}/payments/failure`,
        pending: `${this.configService.get<string>('API_BASE_URL')}/payments/pending`,
      },
      auto_return: 'approved',
      external_reference: saleId,
      notification_url: `${this.configService.get<string>('API_BASE_URL')}/sales/webhook`,
    };

    try {
      const response = await preference.create({ body: preferenceData });
      let paymentLink = response.init_point;
      let qrImageBase64: string | undefined;
      let qrS3Url: string | undefined;

      if (dto.generateQrImage && paymentLink) {
        qrImageBase64 = await QRCode.toDataURL(paymentLink);
        const qrKey = `qrs/sale-${saleId}-${uuidv4()}.png`;
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket:
              this.configService.get<string>('S3_BUCKET') ||
              'ticket-qr-bucket-dev-v2',
            Key: qrKey,
            Body: Buffer.from(qrImageBase64.split(',')[1], 'base64'),
            ContentType: 'image/png',
          }),
        );
        qrS3Url = `https://${this.configService.get<string>('S3_BUCKET')}.s3.amazonaws.com/${qrKey}`;
      }

      return {
        paymentLink,
        preferenceId: response.id,
        qrImageBase64,
        qrS3Url,
        saleId,
      };
    } catch (error) {
      throw new BadRequestException(`Error al generar QR: ${error.message}`);
    }
  }
}
