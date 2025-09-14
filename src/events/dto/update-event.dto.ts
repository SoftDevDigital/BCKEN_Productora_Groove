import { IsString, IsOptional, IsDateString } from 'class-validator';
import { Multer } from 'multer';

export class UpdateEventDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsOptional()
  image?: Multer.File; // Imagen del evento (enviada como archivo)
}