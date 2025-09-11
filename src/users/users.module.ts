import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';
import { SalesModule } from '../sales/sales.module';
import { EventsModule } from '../events/events.module';
import { BatchesModule } from '../batches/batches.module';

@Module({
  imports: [
    AWSSDKModule,
    forwardRef(() => SalesModule),
    EventsModule,
    BatchesModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
