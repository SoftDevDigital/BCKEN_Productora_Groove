import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { AWSSDKModule } from './aws-sdk/aws-sdk.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Hacer ConfigModule disponible globalmente
      envFilePath: '.env', // Opcional: usa un archivo .env para variables
    }),
    AuthModule,
    EventsModule,
    AWSSDKModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
