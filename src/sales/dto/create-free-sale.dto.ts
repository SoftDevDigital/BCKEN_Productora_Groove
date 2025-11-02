import { IsString, IsInt, Min } from 'class-validator';

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
}

