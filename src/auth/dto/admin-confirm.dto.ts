import { IsString, IsNotEmpty } from 'class-validator';

export class AdminConfirmDto {
  @IsString()
  @IsNotEmpty()
  username: string;
}
