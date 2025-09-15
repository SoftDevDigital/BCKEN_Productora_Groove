import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  HttpException,
  HttpStatus,
  UsePipes,
  ValidationPipe,
  UseInterceptors,
  UploadedFile,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { SearchEventDto } from './dto/search.dto';
import type { Request } from 'express';
import { Multer } from 'multer';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

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
  @UseInterceptors(FileInterceptor('image'))
  async create(
    @Body() createEventDto: CreateEventDto,
    @UploadedFile() image: Multer.File,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      if (image) {
        createEventDto.image = image;
      }
      const event = await this.eventsService.create(createEventDto);
      return {
        statusCode: HttpStatus.CREATED,
        message: 'Evento creado exitosamente',
        data: event,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Error al crear evento: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get()
  async findAll() {
    try {
      const events = await this.eventsService.findAll();
      return {
        statusCode: HttpStatus.OK,
        message: 'Eventos obtenidos exitosamente',
        data: events,
      };
    } catch (error) {
      throw new HttpException(
        'Error al obtener eventos',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('search')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async search(@Query() query: SearchEventDto) {
    try {
      const events = await this.eventsService.search(query);
      return {
        statusCode: HttpStatus.OK,
        message: 'Búsqueda de eventos realizada exitosamente',
        data: events,
      };
    } catch (error) {
      throw new HttpException(
        'Error al buscar eventos',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('debug')
  async debug() {
    try {
      const events = await this.eventsService.debug();
      return {
        statusCode: HttpStatus.OK,
        message: 'Datos crudos de eventos obtenidos',
        data: events,
      };
    } catch (error) {
      throw new HttpException(
        'Error al obtener datos crudos de eventos',
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
      return {
        statusCode: HttpStatus.OK,
        message: 'Evento obtenido exitosamente',
        data: event,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al obtener evento',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put(':id')
  @UsePipes(new ValidationPipe({ transform: true }))
  @UseInterceptors(FileInterceptor('image'))
  async update(
    @Param('id') id: string,
    @Body() updateEventDto: UpdateEventDto,
    @UploadedFile() image: Multer.File,
    @Req() req: Request,
  ) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      if (image) {
        updateEventDto.image = image;
      }
      const updatedEvent = await this.eventsService.update(id, updateEventDto);
      return {
        statusCode: HttpStatus.OK,
        message: 'Evento actualizado exitosamente',
        data: updatedEvent,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Error al actualizar evento: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    try {
      const claims = this.getClaims(req);
      this.ensureAdmin(claims);
      const event = await this.eventsService.findOne(id);
      if (!event) {
        throw new HttpException('Evento no encontrado', HttpStatus.NOT_FOUND);
      }
      const result = await this.eventsService.delete(id);
      return {
        statusCode: HttpStatus.OK,
        message: result.message,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Error al eliminar evento y sus tandas',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
