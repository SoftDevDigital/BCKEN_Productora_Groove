import { IsString, IsNumber, IsBoolean, IsOptional } from 'class-validator';

export class CreateQrDto {
  @IsString()
  title: string;

  @IsNumber()
  amount: number;

  @IsBoolean()
  @IsOptional()
  generateQrImage?: boolean;

  @IsString()
  saleId: string;
}
