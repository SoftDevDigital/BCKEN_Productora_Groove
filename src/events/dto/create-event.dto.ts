import { IsEmail, IsString, MinLength, IsNotEmpty } from 'class-validator';

export class CreateEventDto {
  name: string;
  date: string;
  location: string;
}
