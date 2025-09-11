import { IsString, IsInt, Min, IsNumber, IsOptional } from 'class-validator';

export class UpdateBatchDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  totalTickets?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number; // Precio en ARS (o moneda configurada)
}
