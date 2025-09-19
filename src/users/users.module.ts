import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';
import { EventsModule } from '../events/events.module';
import { BatchesModule } from '../batches/batches.module';

@Module({
  imports: [
    AWSSDKModule,
    EventsModule,
    BatchesModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService], // Exportar UsersService explícitamente
})
export class UsersModule {}