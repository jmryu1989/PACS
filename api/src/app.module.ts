import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PacsController } from './pacs.controller';
import { PacsService } from './pacs.service';
import { OrthancService } from './orthanc.service';
import { KeycloakService } from './keycloak.service';

@Module({
  controllers: [PacsController],
  providers: [PrismaService, PacsService, OrthancService, KeycloakService],
})
export class AppModule {}
