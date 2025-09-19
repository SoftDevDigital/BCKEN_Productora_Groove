import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CognitoService } from './cognito/cognito.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module'; // Importar UsersModule

@Module({
  imports: [ConfigModule.forRoot(), UsersModule], // Añadir UsersModule
  providers: [CognitoService],
  exports: [CognitoService],
  controllers: [AuthController],
})
export class AuthModule {}
