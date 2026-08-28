import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PacsController } from './pacs.controller';
import { PacsService } from './pacs.service';

@Module({
  controllers: [PacsController],
  providers: [PrismaService, PacsService],
})
export class AppModule {}
