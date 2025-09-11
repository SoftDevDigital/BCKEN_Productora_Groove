import { Module, forwardRef } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';
import { SalesModule } from '../sales/sales.module';
import { TicketsModule } from '../tickets/tickets.module';
import { UsersModule } from '../users/users.module';
import { EventsModule } from '../events/events.module';
import { BatchesModule } from '../batches/batches.module';

@Module({
  imports: [
    AWSSDKModule,
    forwardRef(() => SalesModule),
    TicketsModule,
    forwardRef(() => UsersModule),
    EventsModule,
    BatchesModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
