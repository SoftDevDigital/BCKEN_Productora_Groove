import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';

@Module({
  imports: [AWSSDKModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
