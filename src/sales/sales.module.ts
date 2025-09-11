import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { EventsModule } from '../events/events.module';
import { BatchesModule } from '../batches/batches.module';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';
import { PaymentsModule } from '../payments/payments.module';
import { TicketsModule } from '../tickets/tickets.module';

@Module({
  imports: [
    EventsModule,
    BatchesModule,
    AWSSDKModule,
    PaymentsModule,
    TicketsModule,
  ],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
