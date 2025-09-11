import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { CognitoService } from './cognito/cognito.service';
import { ConfigModule } from '@nestjs/config';
import { AWSSDKModule } from '../aws-sdk/aws-sdk.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    ConfigModule,
    AWSSDKModule,
    forwardRef(() => UsersModule), // Importar UsersModule con forwardRef
  ],
  controllers: [AuthController],
  providers: [CognitoService],
  exports: [CognitoService],
})
export class AuthModule {}
