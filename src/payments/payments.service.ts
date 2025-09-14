import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { CreateQrDto } from './dto/create-qr.dto';

@Injectable()
export class PaymentsService {
  public client: MercadoPagoConfig;

  constructor(private configService: ConfigService) {
    const accessToken =
      'APP_USR-8581189409054279-091018-c6d03928f1a9466fb3fbc1cdbcf80512-2369426390';
    if (!accessToken) {
      throw new BadRequestException(
        'MERCADO_PAGO_ACCESS_TOKEN is not defined in environment variables',
      );
    }
    console.log('MercadoPago Access Token:', accessToken); // Log para debug
    this.client = new MercadoPagoConfig({
      accessToken,
      options: { timeout: 5000 },
    });
  }

  async generateQr(dto: CreateQrDto, saleId: string): Promise<any> {
    const preference = new Preference(this.client);
    const apiBaseUrl = this.configService.get<string>('API_BASE_URL');
    if (!apiBaseUrl) {
      throw new BadRequestException(
        'API_BASE_URL is not defined in environment variables',
      );
    }

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
        success: `https://df2c6b52db81.ngrok-free.app/payments/success?saleId=${saleId}`,
        failure: `https://df2c6b52db81.ngrok-free.app/payments/failure?saleId=${saleId}`,
        pending: `https://df2c6b52db81.ngrok-free.app/payments/pending?saleId=${saleId}`,
      },
      auto_return: 'approved',
      external_reference: saleId,
      notification_url: `https://df2c6b52db81.ngrok-free.app/sales/webhook`,
    };

    try {
      const response = await preference.create({ body: preferenceData });
      console.log('Preference created:', response.id); // Log para debug
      return {
        paymentLink: response.init_point,
        preferenceId: response.id,
        saleId,
      };
    } catch (error) {
      console.error('Error generating preference:', error); // Log para debug
      throw new BadRequestException(
        `Error al generar link de pago: ${error.message}`,
      );
    }
  }

  async getPaymentStatus(paymentId: string): Promise<any> {
    const payment = new Payment(this.client);
    try {
      const response = await payment.get({ id: paymentId });
      console.log('Payment status retrieved:', {
        id: paymentId,
        status: response.status,
      }); // Log para debug
      return response;
    } catch (error) {
      console.error('Error retrieving payment status:', error); // Log para debug
      throw new BadRequestException(
        `Error al verificar pago: ${error.message}`,
      );
    }
  }
}
