import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forRoot()], // Para acceder a .env
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
