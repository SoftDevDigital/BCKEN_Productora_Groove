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
        'MERCADOPAGO_ACCESS_TOKEN_PROD no está definido en las variables de entorno',
      );
    }
    this.client = new MercadoPagoConfig({
      accessToken,
      options: { timeout: 5000 },
    });
  }
  async generateQr(dto: CreateQrDto, saleId: string): Promise<any> {
    if (!saleId) {
      throw new BadRequestException('El saleId es requerido');
    }
    const preference = new Preference(this.client);
    const apiBaseUrl = this.configService.get<string>('URL_DOMINIO_BACKEND');
    if (!apiBaseUrl) {
      throw new BadRequestException(
        'URL_DOMINIO_BACKEND no está definido en las variables de entorno',
      );
    }
    const successUrl = `${apiBaseUrl}/payments/success?saleId=${saleId}`;
    const failureUrl = `${apiBaseUrl}/payments/failure?saleId=${saleId}`;
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
        success: successUrl,
        failure: failureUrl,
        pending: successUrl, // Redirige pending a success
      },
      auto_return: 'approved',
      external_reference: saleId,
      notification_url: `${apiBaseUrl}/sales/webhook`,
    };
    try {
      const response = await preference.create({ body: preferenceData });
      console.log('Preferencia creada:', {
        preferenceId: response.id,
        saleId,
        init_point: response.init_point,
      });
      return {
        paymentLink: response.init_point,
        preferenceId: response.id,
        saleId,
      };
    } catch (error) {
      console.error('Error al generar preferencia:', error);
      throw new BadRequestException(
        `Error al generar link de pago: ${error.message}`,
      );
    }
  }
  async getPaymentStatus(paymentId: string): Promise<any> {
    if (!paymentId) {
      throw new BadRequestException('El paymentId es requerido');
    }
    const payment = new Payment(this.client);
    try {
      const response = await payment.get({ id: paymentId });
      console.log('Estado del pago obtenido:', {
        paymentId,
        status: response.status,
        external_reference: response.external_reference,
      });
      return response;
    } catch (error) {
      console.error('Error al obtener estado del pago:', error);
      throw new BadRequestException(
        `Error al verificar pago: ${error.message}`,
      );
    }
  }
}