import { IsString, IsInt, Min, IsOptional, IsBoolean } from 'class-validator';

export class CreateFreeSaleDto {
  @IsString()
  eventId: string;

  @IsString()
  batchId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsString()
  buyerEmailOrAlias: string; // Email o alias del usuario que recibirá el ticket gratis

  @IsOptional()
  @IsBoolean()
  isBirthday?: boolean; // Indica si es un ticket de cumpleañero

  @IsOptional()
  @IsString()
  birthdayPersonName?: string; // Nombre del cumpleañero (si isBirthday = true)

  @IsOptional()
  @IsBoolean()
  isBackstage?: boolean; // Indica si es un ticket Backstage (asignación especial del admin)
}

