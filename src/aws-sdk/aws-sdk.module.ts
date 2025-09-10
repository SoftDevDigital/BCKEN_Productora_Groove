import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

@Module({
  providers: [
    {
      provide: 'DYNAMODB_CLIENT',
      useFactory: (configService: ConfigService) => {
        return new DynamoDBClient({
          region: configService.get('AWS_REGION') || 'us-east-1',
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: ['DYNAMODB_CLIENT'], // Exportar para que otros módulos lo usen
})
export class AWSSDKModule {}
