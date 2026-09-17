import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { GovernanceRoleModule } from "../governance-role/governance-role.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { IdentityRevocationController } from "./identity-revocation.controller.js";
import { IdentityRevocationService } from "./identity-revocation.service.js";
import { HttpSessionRevoker, SESSION_REVOKER } from "./session-revoker.port.js";

@Module({
  imports: [PrismaModule, GovernanceRoleModule],
  controllers: [IdentityRevocationController],
  providers: [
    IdentityRevocationService,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
    { provide: SESSION_REVOKER, useClass: HttpSessionRevoker },
  ],
  exports: [IdentityRevocationService],
})
export class IdentityRevocationModule {}
