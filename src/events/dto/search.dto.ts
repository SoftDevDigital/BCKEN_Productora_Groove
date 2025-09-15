import { IsString, IsOptional, IsDateString } from 'class-validator';

export class SearchEventDto {
  @IsOptional()
  @IsString()
  q?: string; // Búsqueda general (nombre, descripción, ubicación)

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  from?: string; // Fecha de inicio (formato ISO)

  @IsOptional()
  @IsDateString()
  to?: string; // Fecha de fin (formato ISO)
}
