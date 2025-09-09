import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CognitoService } from './cognito/cognito.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [ConfigModule.forRoot()],
  providers: [CognitoService],
  exports: [CognitoService],
  controllers: [AuthController],
})
export class AuthModule {}
