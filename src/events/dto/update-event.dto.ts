import { IsEmail, IsString, MinLength, IsNotEmpty } from 'class-validator';

export class UpdateEventDto {
  name?: string;
  date?: string;
  location?: string;
  totalTickets?: number;
}
