import { IsString, IsNotEmpty } from 'class-validator';

export class ConfirmDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  code: string;
}
