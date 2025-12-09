import * as dotenv from 'dotenv';
dotenv.config();
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Idempotency-Key',
      'Accept',
      'Origin',
      'X-Requested-With',
      'Access-Control-Request-Method',
      'Access-Control-Request-Headers',
      'X-Content-Type-Options',
      'X-CSRF-Token',
    ],
    exposedHeaders: ['X-Idempotency-Key', 'Content-Type', 'Authorization'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  
  // Global exception filter para mejor logging
  app.useGlobalFilters({
    catch(exception: any, host: any) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse();
      const request = ctx.getRequest();
      
      console.error('=== GLOBAL ERROR ===');
      console.error('Path:', request.url);
      console.error('Method:', request.method);
      console.error('Error:', exception?.message);
      console.error('Stack:', exception?.stack);
      console.error('===================');
      
      const status = exception?.status || exception?.statusCode || 500;
      const message = exception?.message || 'Internal server error';
      
      response.status(status).json({
        statusCode: status,
        message,
        error: exception?.name || 'Error',
        ...(process.env.NODE_ENV === 'development' && { stack: exception?.stack }),
      });
    },
  });
  
  await app.listen(process.env.PORT || 3001);
  console.log(`🚀 Server running on port ${process.env.PORT || 3001}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 AWS Region: ${process.env.AWS_REGION || 'us-east-1'}`);
  console.log(`🔗 AWS Endpoint: ${process.env.AWS_ENDPOINT_URL || 'AWS Real'}`);
}
bootstrap();
