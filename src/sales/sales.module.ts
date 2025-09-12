import { Module, forwardRef } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { EventsModule } from '../events/events.module';
import { BatchesModule } from '../batches/batches.module';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';
import { TicketsModule } from '../tickets/tickets.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    EventsModule,
    BatchesModule,
    AWSSDKModule,
    TicketsModule,
    forwardRef(() => UsersModule),
  ],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}