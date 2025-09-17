// Updated: src/payments/payments.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { CreateQrDto } from './dto/create-qr.dto';
@Injectable()
export class PaymentsService {
  public client: MercadoPagoConfig;
  constructor(private configService: ConfigService) {
    const accessToken = this.configService.get<string>(
      'MERCADOPAGO_ACCESS_TOKEN_PROD',
    );
    if (!accessToken) {
      throw new BadRequestException(
        'MERCADOPAGO_ACCESS_TOKEN_PROD is not defined in environment variables',
      );
    }
    this.client = new MercadoPagoConfig({
      accessToken,
      options: { timeout: 5000 },
    });
  }
  async generateQr(dto: CreateQrDto, saleId: string): Promise<any> {
    const preference = new Preference(this.client);
    const apiBaseUrl = this.configService.get<string>('URL_DOMINIO_BACKEND') || 'https://api.fest-go.com';
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
      return response;
    } catch (error) {
      console.error('Error retrieving payment status:', error); // Log para debug
      throw new BadRequestException(
        `Error al verificar pago: ${error.message}`,
      );
    }
  }
}
