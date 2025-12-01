import {
  IsString,
  IsInt,
  Min,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsDateString,
} from 'class-validator';

export class UpdateBatchDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  totalTickets?: number; // Total de tickets en la tanda

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number; // Precio en ARS (o moneda configurada)

  @IsOptional()
  @IsBoolean()
  isVip?: boolean; // Indica si la tanda es VIP

  @IsOptional()
  @IsBoolean()
  isAfter?: boolean; // Indica si la tanda es After

  @IsOptional()
  @IsBoolean()
  isBackstage?: boolean; // Indica si la tanda es Backstage

  @IsOptional()
  @IsDateString()
  startTime?: string; // Horario de inicio de la tanda (formato ISO)

  @IsOptional()
  @IsDateString()
  endTime?: string; // Horario de finalización de la tanda (formato ISO)
}
