import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class GeneratePaymentDto {
  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsString()
  @IsNotEmpty()
  batchId: string;

  @IsNumber()
  @IsNotEmpty()
  quantity: number;

  @IsString()
  @IsOptional()
  userAlias?: string;

  @IsString()
  @IsOptional()
  userEmail?: string;
}
