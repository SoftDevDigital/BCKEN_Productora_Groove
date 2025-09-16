import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import serverlessExpress from '@vendia/serverless-express';
import { Callback, Context, Handler } from 'aws-lambda';

let server: Handler;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Lista de orígenes permitidos para CORS
  const allowedOrigins = [
    'http://localhost:3000', // Para desarrollo local
    'https://fest-go.com', // Dominio principal en producción
  ];

  app.enableCors({
    origin: (origin, callback) => {
      // Permitir solicitudes sin origen (como las de herramientas como Postman)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('No permitido por CORS'));
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true,
  });

  await app.init();
  const expressApp = app.getHttpAdapter().getInstance();
  return serverlessExpress({ app: expressApp });
}

// Handler para Lambda
export const handler: Handler = async (
  event: any,
  context: Context,
  callback: Callback,
) => {
  server = server || (await bootstrap());
  return server(event, context, callback);
};

// Ejecución local para desarrollo
if (process.env.NODE_ENV !== 'production') {
  async function startLocal() {
    const app = await NestFactory.create(AppModule);

    // Configuración de CORS para desarrollo local
    app.enableCors({
      origin: 'http://localhost:3000',
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
      allowedHeaders: 'Content-Type, Authorization',
      credentials: true,
    });

    await app.listen(process.env.PORT || 3001);
  }
  startLocal();
}
