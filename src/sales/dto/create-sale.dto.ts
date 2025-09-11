import { IsString, IsInt, Min, IsEnum, IsOptional } from 'class-validator';

export class CreateSaleDto {
  @IsString()
  eventId: string;

  @IsString()
  batchId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsEnum(['direct', 'reseller'])
  type: 'direct' | 'reseller';

  @IsOptional()
  @IsString()
  resellerId?: string; // Obligatorio si type es 'reseller'
}
