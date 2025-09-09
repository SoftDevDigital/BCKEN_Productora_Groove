import { IsEmail, IsString, MinLength, IsNotEmpty } from 'class-validator';

export class SignUpDto {
  @IsNotEmpty()
  @IsString()
  name: string; // given_name

  @IsNotEmpty()
  @IsString()
  last_name: string; // family_name

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}
