import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';

@Module({
  imports: [AWSSDKModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
