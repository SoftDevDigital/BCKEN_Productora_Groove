import { IsEmail, IsString, MinLength, IsNotEmpty } from 'class-validator';

export class SignUpDto {
  @IsNotEmpty()
  @IsString()
  nombre: string; // given_name

  @IsNotEmpty()
  @IsString()
  apellido: string; // family_name

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}
