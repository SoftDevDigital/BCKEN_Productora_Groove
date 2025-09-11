import { IsString, IsInt, Min, IsNumber } from 'class-validator';

export class CreateBatchDto {
  @IsString()
  name: string;

  @IsInt()
  @Min(1)
  totalTickets: number;

  @IsNumber()
  @Min(0)
  price: number; // Precio en ARS (o moneda configurada)
}
