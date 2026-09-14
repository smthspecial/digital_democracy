-- CreateEnum
CREATE TYPE "civic_assignment_type" AS ENUM ('proposal_review', 'audit_review', 'expertise_verification', 'budget_oversight');

-- CreateEnum
CREATE TYPE "civic_assignment_status" AS ENUM ('assigned', 'completed', 'abandoned', 'exempted');

-- CreateEnum
CREATE TYPE "exemption_status" AS ENUM ('none', 'illness', 'disability', 'military', 'caregiving', 'other');

-- CreateTable
CREATE TABLE "civic_assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "type" "civic_assignment_type" NOT NULL,
    "target_ref" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" "civic_assignment_status" NOT NULL DEFAULT 'assigned',

    CONSTRAINT "civic_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participation_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "score" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "quota_target" DECIMAL(10,2),
    "exemption_status" "exemption_status" NOT NULL DEFAULT 'none',
    "inactivity_stage" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "participation_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "civic_assignment_citizen_id_idx" ON "civic_assignment"("citizen_id");

-- CreateIndex
CREATE UNIQUE INDEX "participation_record_citizen_id_period_key" ON "participation_record"("citizen_id", "period");

-- CreateIndex
CREATE INDEX "participation_record_citizen_id_idx" ON "participation_record"("citizen_id");

-- AddForeignKey
ALTER TABLE "civic_assignment" ADD CONSTRAINT "civic_assignment_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participation_record" ADD CONSTRAINT "participation_record_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (ADR-024, ARCH-023, adapted to app-level roles per
-- ADR-028) and DB-level consistency, for TBL-024, TBL-025
-- (civic-duty-service/SRV-009). Roles and current_citizen_id() already
-- exist (20260909071102_init) -- this migration only grants and adds
-- policies for the two new tables.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON
  civic_assignment, participation_record
  TO api_app, api_worker;

-- §4: RLS enabled + forced on every table, no exceptions.
ALTER TABLE civic_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE civic_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE participation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE participation_record FORCE ROW LEVEL SECURITY;

-- civic_assignment -- ARCH-023 §6: OWN (assigned citizen only). No _app
-- INSERT policy -- AUTH-009's own guard is explicit: "Citizens cannot
-- self-assign" (generation is DP-040, a worker-only path). The UPDATE
-- policy's USING clause additionally requires the CURRENT row to already be
-- 'assigned' -- AUTH-010's assignment:accept/assignment:abandon only ever
-- transition an in-flight assignment, so this is a real DB-level invariant,
-- not just an app-layer check (mirrors approval_own_role_insert's own extra
-- mile beyond bare ownership). _worker gets a broad ALL policy per §4.3, for
-- DP-040/048/052/054 to use once those cron/async jobs are implemented
-- (out of scope this pass) -- unused by this pass's app code, same as
-- governance_role's worker policies were before this pass used them either.
CREATE POLICY civic_assignment_own_select ON civic_assignment FOR SELECT TO api_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY civic_assignment_own_update ON civic_assignment FOR UPDATE TO api_app
  USING (citizen_id = current_citizen_id() AND status = 'assigned')
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY civic_assignment_worker_all ON civic_assignment FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- participation_record -- ARCH-023 §6: OWN (private participation history,
-- CON-005 layer 1). No _app INSERT policy -- DP-048 (out of scope) is the
-- only creation path; exemption:claim (AUTH-010) only ever updates an
-- existing period's row (see CivicDutyService.claimExemption's own note
-- on this same gap). _worker gets a broad ALL policy per §4.3 for
-- DP-048/049 once implemented.
CREATE POLICY participation_record_own_select ON participation_record FOR SELECT TO api_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY participation_record_own_update ON participation_record FOR UPDATE TO api_app
  USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY participation_record_worker_all ON participation_record FOR ALL TO api_worker
  USING (true) WITH CHECK (true);
