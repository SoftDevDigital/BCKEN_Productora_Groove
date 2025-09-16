import { Module, forwardRef } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { EventsModule } from '../events/events.module';
import { BatchesModule } from '../batches/batches.module';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';
import { PaymentsModule } from '../payments/payments.module';
import { TicketsModule } from '../tickets/tickets.module';
import { UsersModule } from '../users/users.module';
import { EmailService } from '../email/email.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    EventsModule,
    BatchesModule,
    AWSSDKModule,
    PaymentsModule,
    TicketsModule,
    forwardRef(() => UsersModule),
    ConfigModule.forRoot(),
  ],
  controllers: [SalesController],
  providers: [SalesService, EmailService],
  exports: [SalesService],
})
export class SalesModule {}
