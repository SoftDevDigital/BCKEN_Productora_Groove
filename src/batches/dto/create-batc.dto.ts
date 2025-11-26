import {
  IsString,
  IsInt,
  Min,
  IsNumber,
  IsBoolean,
  IsDateString,
} from 'class-validator';

export class CreateBatchDto {
  @IsString()
  name: string;

  @IsInt()
  @Min(1)
  totalTickets: number;

  @IsNumber()
  @Min(0)
  price: number; // Precio en ARS (o moneda configurada)

  @IsBoolean()
  isVip: boolean; // Indica si la tanda es VIP

  @IsBoolean()
  isAfter: boolean; // Indica si la tanda es After

  @IsDateString()
  startTime: string; // Horario de inicio de la tanda (formato ISO)

  @IsDateString()
  endTime: string; // Horario de finalización de la tanda (formato ISO)
}
