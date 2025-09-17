import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import serverlessExpress from '@vendia/serverless-express';
import { Callback, Context, Handler } from 'aws-lambda';

let server: Handler;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Configuración CORS
  app.enableCors({
    origin: ['https://fest-go.com', 'http://localhost:3000'],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Middleware para manejar OPTIONS explícitamente
  app.getHttpAdapter().getInstance().use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
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
    app.enableCors({
      origin: ['https://fest-go.com', 'http://localhost:3000'],
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
      preflightContinue: false,
      optionsSuccessStatus: 204,
    });

    // Middleware para manejar OPTIONS explícitamente
    app.getHttpAdapter().getInstance().use((req, res, next) => {
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });

    await app.listen(process.env.PORT || 3001);
  }
  startLocal();
}