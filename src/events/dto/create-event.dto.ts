import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsOptional,
} from 'class-validator';
import { Multer } from 'multer';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsDateString()
  @IsNotEmpty()
  from: string;

  @IsDateString()
  @IsNotEmpty()
  to: string;

  @IsString()
  @IsNotEmpty()
  location: string;

  @IsOptional()
  image?: Multer.File; // Imagen del evento (enviada como archivo)
}
