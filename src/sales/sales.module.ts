import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { EventsModule } from '../events/events.module';
import { BatchesModule } from '../batches/batches.module';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';

@Module({
  imports: [EventsModule, BatchesModule, AWSSDKModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
