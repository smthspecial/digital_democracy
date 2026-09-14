-- CreateEnum
CREATE TYPE "reputation_factor_type" AS ENUM ('accurate_prediction', 'constructive', 'disclosure', 'successful_proposal', 'misinformation', 'undisclosed_conflict', 'manipulation', 'fraud');

-- CreateEnum
CREATE TYPE "project_status" AS ENUM ('planned', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "project_milestone_status" AS ENUM ('pending', 'done', 'delayed');

-- CreateEnum
CREATE TYPE "outcome_evaluation_result" AS ENUM ('successful', 'partial', 'unsuccessful');

-- CreateEnum
CREATE TYPE "access_policy_effect" AS ENUM ('allow', 'deny');

-- CreateEnum
CREATE TYPE "access_policy_status" AS ENUM ('pending_approval', 'active', 'rejected', 'revoked');

-- CreateEnum
CREATE TYPE "policy_attachment_status" AS ENUM ('pending_approval', 'active', 'revoked');

-- CreateEnum
CREATE TYPE "policy_endorsement_target_type" AS ENUM ('policy', 'attachment');

-- CreateEnum
CREATE TYPE "policy_endorsement_decision" AS ENUM ('approved', 'rejected');

-- CreateTable
CREATE TABLE "reputation_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "factor_type" "reputation_factor_type" NOT NULL,
    "delta" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reputation_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "timeline_start" DATE NOT NULL,
    "timeline_end" DATE NOT NULL,
    "budget_allocated" DECIMAL(14,2),
    "budget_spent" DECIMAL(14,2) DEFAULT 0,
    "contractor" TEXT NOT NULL,
    "status" "project_status" NOT NULL DEFAULT 'planned',

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_milestone" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "completed_at" TIMESTAMP(3),
    "status" "project_milestone_status" NOT NULL DEFAULT 'pending',

    CONSTRAINT "project_milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcome_evaluation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "objective" TEXT NOT NULL,
    "promised_outcome" TEXT NOT NULL,
    "measured_outcome" TEXT NOT NULL,
    "evaluation" "outcome_evaluation_result" NOT NULL,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outcome_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_policy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "effect" "access_policy_effect" NOT NULL,
    "actions" TEXT[],
    "resources" TEXT[],
    "conditions" JSONB,
    "description" TEXT NOT NULL,
    "status" "access_policy_status" NOT NULL DEFAULT 'pending_approval',
    "proposed_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_attachment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_id" UUID NOT NULL,
    "principal_ref" TEXT NOT NULL,
    "status" "policy_attachment_status" NOT NULL DEFAULT 'pending_approval',
    "proposed_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_endorsement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_type" "policy_endorsement_target_type" NOT NULL,
    "target_id" UUID NOT NULL,
    "endorser_citizen_id" UUID NOT NULL,
    "decision" "policy_endorsement_decision" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_endorsement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reputation_record_citizen_id_idx" ON "reputation_record"("citizen_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_proposal_id_key" ON "project"("proposal_id");

-- CreateIndex
CREATE INDEX "project_milestone_project_id_idx" ON "project_milestone"("project_id");

-- CreateIndex
CREATE INDEX "outcome_evaluation_project_id_idx" ON "outcome_evaluation"("project_id");

-- CreateIndex
CREATE INDEX "policy_attachment_policy_id_idx" ON "policy_attachment"("policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_endorsement_target_type_target_id_endorser_citizen_i_key" ON "policy_endorsement"("target_type", "target_id", "endorser_citizen_id");

-- AddForeignKey
ALTER TABLE "reputation_record" ADD CONSTRAINT "reputation_record_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_milestone" ADD CONSTRAINT "project_milestone_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcome_evaluation" ADD CONSTRAINT "outcome_evaluation_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_attachment" ADD CONSTRAINT "policy_attachment_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "access_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (ADR-024, ARCH-023, adapted to app-level roles per
-- ADR-028) and DB-level consistency, for TBL-016, TBL-029..031, TBL-040..042
-- (reputation-service/SRV-014, project-service/SRV-013, iam-service/SRV-018).
-- Roles and current_citizen_id() already exist (20260909071102_init) --
-- this migration only grants and adds policies for the seven new tables.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON
  reputation_record, project, project_milestone, outcome_evaluation,
  access_policy, policy_attachment, policy_endorsement
  TO api_app, api_worker;

-- §4: RLS enabled + forced on every table, no exceptions.
ALTER TABLE reputation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE project ENABLE ROW LEVEL SECURITY;
ALTER TABLE project FORCE ROW LEVEL SECURITY;
ALTER TABLE project_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_milestone FORCE ROW LEVEL SECURITY;
ALTER TABLE outcome_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_evaluation FORCE ROW LEVEL SECURITY;
ALTER TABLE access_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_attachment FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_endorsement ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_endorsement FORCE ROW LEVEL SECURITY;

-- reputation_record -- PUBLIC read; write _worker only (ARCH-023 §6:
-- "system-computed"). No _app policy of any kind -- no citizen-facing
-- write exists for this table; it is written exclusively via an in-process
-- port call from project-service (a later phase), never HTTP.
CREATE POLICY reputation_record_public_read ON reputation_record FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY reputation_record_worker_all ON reputation_record FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- project -- PUBLIC read; write _worker only. `assigned` scope (does this
-- citizen hold an active operator/oversight/auditor governance_role) is
-- cross-service (governance-role-service) and can't be expressed as an RLS
-- row-ownership policy (ARCH-023 §5) -- the app resolves it via
-- GOVERNANCE_ROLE_CHECKER before writing under _worker. No _app policy of
-- any kind. `project` also has no sync creation path at all in this pass
-- (a row is created when a proposal transitions to approved, DP-029, out
-- of scope) -- seeded, like jurisdiction/governance_role.
CREATE POLICY project_public_read ON project FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY project_worker_insert ON project FOR INSERT TO api_worker
  WITH CHECK (true);
CREATE POLICY project_worker_update ON project FOR UPDATE TO api_worker
  USING (true) WITH CHECK (true);

-- project_milestone -- PUBLIC read; write _worker only, same cross-service
-- `assigned`-scope reasoning as project above. No _app policy of any kind.
CREATE POLICY project_milestone_public_read ON project_milestone FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY project_milestone_worker_insert ON project_milestone FOR INSERT TO api_worker
  WITH CHECK (true);
CREATE POLICY project_milestone_worker_update ON project_milestone FOR UPDATE TO api_worker
  USING (true) WITH CHECK (true);

-- outcome_evaluation -- PUBLIC read; INSERT _worker only, same
-- cross-service `assigned`-scope reasoning (the audit/oversight team's
-- role-check runs in application code before this insert). No UPDATE
-- policy on any role -- an evaluation is written once, not amended. No
-- _app policy of any kind.
CREATE POLICY outcome_evaluation_public_read ON outcome_evaluation FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY outcome_evaluation_worker_insert ON outcome_evaluation FOR INSERT TO api_worker
  WITH CHECK (true);

-- access_policy -- PUBLIC read (CON-005, no hidden grants); _app INSERT as
-- proposer (DP-069) -- the "must hold an active operator/platform_operator
-- governance_role" half of that check is role-based, not
-- resource-ownership-based, so it stays in application code (ARCH-023 §5)
-- and runs before this insert. _worker ALL covers activate/reject/revoke
-- (DP-070/DP-072), which have no attribution column to check against.
CREATE POLICY access_policy_public_read ON access_policy FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY access_policy_own_insert ON access_policy FOR INSERT TO api_app
  WITH CHECK (proposed_by = current_citizen_id());
CREATE POLICY access_policy_worker_all ON access_policy FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- policy_attachment -- same shape as access_policy above.
CREATE POLICY policy_attachment_public_read ON policy_attachment FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY policy_attachment_own_insert ON policy_attachment FOR INSERT TO api_app
  WITH CHECK (proposed_by = current_citizen_id());
CREATE POLICY policy_attachment_worker_all ON policy_attachment FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- policy_endorsement -- PUBLIC read; _app INSERT as endorser (DP-070). The
-- "different citizen than the proposer, holding an active role of the same
-- role_type" condition needs a polymorphic target_type/target_id lookup
-- across access_policy/policy_attachment plus a live governance-role-service
-- check, so it stays entirely in application code (ARCH-023 §5), same
-- reasoning as above.
CREATE POLICY policy_endorsement_public_read ON policy_endorsement FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY policy_endorsement_own_insert ON policy_endorsement FOR INSERT TO api_app
  WITH CHECK (endorser_citizen_id = current_citizen_id());
CREATE POLICY policy_endorsement_worker_all ON policy_endorsement FOR ALL TO api_worker
  USING (true) WITH CHECK (true);
