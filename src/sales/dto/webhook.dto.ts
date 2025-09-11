import { IsString, IsEnum } from 'class-validator';

export class WebhookDto {
  @IsString()
  saleId: string;

  @IsEnum(['approved', 'rejected', 'pending'])
  paymentStatus: 'approved' | 'rejected' | 'pending';

  @IsString()
  paymentId: string;
}
