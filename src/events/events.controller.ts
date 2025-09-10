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
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import type { Request } from 'express';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  private getClaims(req: Request): any {
    let claims: any = null;
    // Caso Lambda con API Gateway
    if (req['apiGateway']) {
      const ctx = req['apiGateway'].event.requestContext;
      claims = ctx.authorizer?.jwt?.claims || ctx.authorizer?.claims || null;
    }
    // Caso local con Express
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

  @Get()
  async findAll() {
    try {
      return await this.eventsService.findAll();
    } catch (error) {
      throw new HttpException(
        'Error al obtener eventos',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post()
  @UsePipes(new ValidationPipe({ transform: true }))
  async create(@Body() dto: CreateEventDto, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      return await this.eventsService.create(dto);
    } catch (error) {
      throw new HttpException(
        'Error al crear evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    try {
      const event = await this.eventsService.findOne(id);
      if (!event) {
        throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
      }
      return event;
    } catch (error) {
      throw new HttpException(
        'Error al obtener evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put(':id')
  @UsePipes(new ValidationPipe({ transform: true }))
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const updatedEvent = await this.eventsService.update(id, dto);
      if (!updatedEvent) {
        throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
      }
      return updatedEvent;
    } catch (error) {
      throw new HttpException(
        'Error al actualizar evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const result = await this.eventsService.remove(id);
      if (!result) {
        throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
      }
      return { message: `Evento ${id} eliminado` };
    } catch (error) {
      throw new HttpException(
        'Error al eliminar evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
