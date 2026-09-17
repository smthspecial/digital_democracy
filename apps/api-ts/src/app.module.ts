import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { BudgetModule } from "./budget/budget.module.js";
import { CivicDutyModule } from "./civic-duty/civic-duty.module.js";
import { CompetencyModule } from "./competency/competency.module.js";
import { DeliberationModule } from "./deliberation/deliberation.module.js";
import { GovernanceRoleModule } from "./governance-role/governance-role.module.js";
import { HealthModule } from "./health/health.module.js";
import { IamModule } from "./iam/iam.module.js";
import { IdentityRevocationModule } from "./identity/identity-revocation.module.js";
import { IdentityModule } from "./identity/identity.module.js";
import { JurisdictionModule } from "./jurisdiction/jurisdiction.module.js";
import { MetricsModule } from "./metrics/metrics.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { ProblemModule } from "./problem/problem.module.js";
import { ProjectModule } from "./project/project.module.js";
import { ProposalModule } from "./proposal/proposal.module.js";
import { ReputationModule } from "./reputation/reputation.module.js";

// PrismaModule is @Global() (prisma.module.ts) -- imported here once so
// PrismaService is available to every feature module's repository without
// each of them importing it individually.
//
// notification-service (SRV-015) and ai-synthesis-service (SRV-016) are not
// modules here -- both own no tables per ARCH-023 §1 ("out of scope for
// this pass") and have no sync HTTP operations of their own. notification-
// service is realized only as the NOTIFICATION_EMITTER port (common/
// notification-emitter.ts) other modules call; ai-synthesis-service has no
// footprint in this app at all (see ADR-031).
@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    MetricsModule,
    IdentityModule,
    IdentityRevocationModule,
    JurisdictionModule,
    ProposalModule,
    ProblemModule,
    CompetencyModule,
    DeliberationModule,
    BudgetModule,
    GovernanceRoleModule,
    CivicDutyModule,
    ReputationModule,
    ProjectModule,
    IamModule,
  ],
})
export class AppModule {}
