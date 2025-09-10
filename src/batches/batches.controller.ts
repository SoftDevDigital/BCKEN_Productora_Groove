import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Put,
  Delete,
  UsePipes,
  ValidationPipe,
  HttpException,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { BatchesService } from './batches.service';
import { CreateBatchDto } from './dto/create-batc.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import type { Request } from 'express';

@Controller('events/:eventId/batches')
export class BatchesController {
  constructor(private readonly batchesService: BatchesService) {}

  private getClaims(req: Request): any {
    let claims: any = null;
    if (req['apiGateway']) {
      const ctx = req['apiGateway'].event.requestContext;
      claims = ctx.authorizer?.jwt?.claims || ctx.authorizer?.claims || null;
    }
    if (!claims) {
      const token = req.headers['authorization']?.replace('Bearer ', '');
      if (token) {
        claims = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString(),
        );
      }
    }
    return claims;
  }

  private ensureAdmin(claims: any) {
    const userRole = claims?.['custom:role'] || 'User';
    if (userRole !== 'Admin') {
      throw new HttpException(
        'No autorizado: Requiere rol Admin',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  @Post()
  @UsePipes(new ValidationPipe({ transform: true }))
  async create(
    @Param('eventId') eventId: string,
    @Body() dto: CreateBatchDto,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      return await this.batchesService.create(eventId, dto);
    } catch (error) {
      throw new HttpException(
        'Error al crear tanda',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get()
  async findAll(@Param('eventId') eventId: string) {
    try {
      return await this.batchesService.findAll(eventId);
    } catch (error) {
      throw new HttpException(
        'Error al obtener tandas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put(':batchId')
  @UsePipes(new ValidationPipe({ transform: true }))
  async update(
    @Param('eventId') eventId: string,
    @Param('batchId') batchId: string,
    @Body() dto: UpdateBatchDto,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const updatedBatch = await this.batchesService.update(
        eventId,
        batchId,
        dto,
      );
      if (!updatedBatch) {
        throw new HttpException('Tanda no encontrada', HttpStatus.NOT_FOUND);
      }
      return updatedBatch;
    } catch (error) {
      throw new HttpException(
        'Error al actualizar tanda',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':batchId')
  async remove(
    @Param('eventId') eventId: string,
    @Param('batchId') batchId: string,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const result = await this.batchesService.remove(eventId, batchId);
      if (!result) {
        throw new HttpException('Tanda no encontrada', HttpStatus.NOT_FOUND);
      }
      return { message: `Tanda ${batchId} eliminada` };
    } catch (error) {
      throw new HttpException(
        'Error al eliminar tanda',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
