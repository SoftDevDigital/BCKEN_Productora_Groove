import { IsEmail } from 'class-validator';

export class ResendDto {
  @IsEmail()
  email: string;
}
