import { Injectable, BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { CreateQrDto } from './dto/create-qr.dto';
@Injectable()
export class PaymentsService {
  public client: MercadoPagoConfig;
  constructor(private configService: ConfigService) {
    const accessToken = 'APP_USR-1049987662578660-091714-2f127cb7d32ec0c4d4760493f6b757d5-481807388'
    if (!accessToken || accessToken.trim() === '') {
      throw new InternalServerErrorException(
        'MERCADOPAGO_ACCESS_TOKEN_PROD no está definido o está vacío en las variables de entorno',
      );
    }
    try {
      this.client = new MercadoPagoConfig({
        accessToken,
        options: { timeout: 5000 },
      });
    } catch (error) {
      throw new InternalServerErrorException(
        'Error al inicializar el cliente de Mercado Pago: configuración inválida',
      );
    }
  }
  private validateId(id: string, fieldName: string = 'ID'): void {
    if (!id || id.trim() === '') {
      throw new BadRequestException(`El ${fieldName} no puede estar vacío`);
    }
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(id)) {
      throw new BadRequestException(`El ${fieldName} no tiene un formato válido (debe ser un UUID)`);
    }
  }
  private validatePaymentId(id: string, fieldName: string = 'paymentId'): void {
    if (!id || id.trim() === '') {
      throw new BadRequestException(`El ${fieldName} no puede estar vacío`);
    }
  }
  private validateNumber(value: number, fieldName: string, allowZero: boolean = false): void {
    if (typeof value !== 'number' || (allowZero ? value < 0 : value <= 0)) {
      throw new BadRequestException(
        `El ${fieldName} debe ser un número ${allowZero ? 'no negativo' : 'positivo'}`,
      );
    }
  }
  async generateQr(dto: CreateQrDto, saleId: string): Promise<any> {
    this.validateId(saleId, 'saleId');
    if (!dto.title || !dto.title.trim()) {
      throw new BadRequestException('El título es requerido y no puede estar vacío');
    }
    this.validateNumber(dto.amount, 'monto');
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
        success: `https://api.fest-go.com/payments/success?saleId=${saleId}`,
        failure: `https://api.fest-go.com/payments/failure?saleId=${saleId}`,
        pending: `https://api.fest-go.com/payments/success?saleId=${saleId}`, // Redirige pending a success
      },
      auto_return: 'approved',
      external_reference: saleId,
      notification_url: `https://api.fest-go.com/sales/webhook?source_news=webhooks`,
    };
    try {
      const response = await preference.create({ body: preferenceData });
      console.log('Preferencia creada:', {
        preferenceId: response.id,
        saleId,
        init_point: response.init_point,
      });
      if (!response.init_point) {
        throw new InternalServerErrorException(
          'Respuesta inválida de Mercado Pago: init_point no está presente',
        );
      }
      return {
        paymentLink: response.init_point,
        preferenceId: response.id,
        saleId,
      };
    } catch (error) {
      console.error('Error al generar preferencia:', error);
      throw new InternalServerErrorException(
        `Error al generar link de pago: ${error.message}`,
      );
    }
  }
  async getPaymentStatus(paymentId: string): Promise<any> {
    this.validatePaymentId(paymentId, 'paymentId');
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
      if (error.status === 404) {
        throw new NotFoundException(`Pago no encontrado: ${paymentId}`);
      }
      throw new InternalServerErrorException(
        `Error al verificar pago: ${error.message}`,
      );
    }
  }
}