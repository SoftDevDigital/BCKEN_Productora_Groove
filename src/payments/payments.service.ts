import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import { CreateQrDto } from './dto/create-qr.dto';
import * as QRCode from 'qrcode';

@Injectable()
export class PaymentsService {
  private client: MercadoPagoConfig;

  constructor(private configService: ConfigService) {
    const accessToken =
      'APP_USR-8581189409054279-091018-c6d03928f1a9466fb3fbc1cdbcf80512-2369426390';
    if (!accessToken) {
      throw new BadRequestException(
        'MERCADO_PAGO_ACCESS_TOKEN is not defined in environment variables',
      );
    }
    this.client = new MercadoPagoConfig({ accessToken });
  }

  async generateQr(dto: CreateQrDto): Promise<any> {
    const preference = new Preference(this.client);

    const preferenceData = {
      items: [
        {
          id: 'item-' + Math.random().toString(36).substring(2, 10),
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
        success: 'https://tu-dominio.com/success',
        failure: 'https://tu-dominio.com/failure',
        pending: 'https://tu-dominio.com/pending',
      },
      auto_return: 'approved',
    };

    try {
      const response = await preference.create({ body: preferenceData });

      let paymentLink = response.init_point;

      let qrImageBase64: string | undefined;
      if (dto.generateQrImage && paymentLink) {
        qrImageBase64 = await QRCode.toDataURL(paymentLink); // Espera la promesa
      }

      return {
        paymentLink, // Siempre retorna el link si existe
        preferenceId: response.id,
        qrImageBase64, // Solo si se solicitó y paymentLink está disponible
      };
    } catch (error) {
      throw new BadRequestException(`Error al generar QR: ${error.message}`);
    }
  }
}
