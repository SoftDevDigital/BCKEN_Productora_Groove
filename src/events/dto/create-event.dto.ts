import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsOptional,
} from 'class-validator';

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
  image?: any; // Imagen del evento (enviada como archivo multipart/form-data)
}
