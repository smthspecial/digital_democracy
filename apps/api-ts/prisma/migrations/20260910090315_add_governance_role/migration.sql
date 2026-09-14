-- CreateEnum
CREATE TYPE "governance_role_type" AS ENUM ('auditor', 'reviewer', 'oversight', 'operator', 'platform_operator', 'review_body');

-- CreateEnum
CREATE TYPE "governance_layer" AS ENUM ('protocol', 'implementation', 'audit', 'citizen');

-- CreateEnum
CREATE TYPE "approval_type" AS ENUM ('citizen_supermajority', 'audit_confirmation', 'body_endorsement');

-- CreateEnum
CREATE TYPE "approval_decision" AS ENUM ('approved', 'rejected');

-- CreateTable
CREATE TABLE "governance_role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "role_type" "governance_role_type" NOT NULL,
    "layer" "governance_layer" NOT NULL,
    "term_start" DATE NOT NULL,
    "term_end" DATE NOT NULL,
    "randomized" BOOLEAN NOT NULL,

    CONSTRAINT "governance_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action_ref" TEXT NOT NULL,
    "approver_role_id" UUID NOT NULL,
    "approval_type" "approval_type" NOT NULL,
    "decision" "approval_decision" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "governance_role_citizen_id_idx" ON "governance_role"("citizen_id");

-- CreateIndex
CREATE INDEX "approval_approver_role_id_idx" ON "approval"("approver_role_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_action_ref_approver_role_id_key" ON "approval"("action_ref", "approver_role_id");

-- AddForeignKey
ALTER TABLE "governance_role" ADD CONSTRAINT "governance_role_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_approver_role_id_fkey" FOREIGN KEY ("approver_role_id") REFERENCES "governance_role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (ADR-024, ARCH-023, adapted to app-level roles per
-- ADR-028) and DB-level consistency, for TBL-032, TBL-033
-- (governance-role-service/SRV-011). Roles and current_citizen_id() already
-- exist (20260909071102_init) -- this migration only grants and adds
-- policies for the two new tables.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON
  governance_role, approval
  TO api_app, api_worker;

-- §4: RLS enabled + forced on every table, no exceptions.
ALTER TABLE governance_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_role FORCE ROW LEVEL SECURITY;
ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval FORCE ROW LEVEL SECURITY;

-- governance_role -- PUBLIC read (transparency of role/term, ARCH-023 §6);
-- write _worker only (reference-ish data, mirrors jurisdiction/
-- expert_domain/budget_category -- every creation path (DP-040/062/063/064/
-- 065/068) is async/cron, out of scope this pass, so no citizen-facing
-- create/update op exists).
CREATE POLICY governance_role_public_read ON governance_role FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY governance_role_worker_insert ON governance_role FOR INSERT TO api_worker
  WITH CHECK (true);
CREATE POLICY governance_role_worker_update ON governance_role FOR UPDATE TO api_worker
  USING (true) WITH CHECK (true);

-- approval -- PUBLIC read (FR-007 "every disabling action is logged with all
-- approvers" / CON-005 anti-hidden-governance transparency) + local-parent
-- OWN insert: the first table needing ARCH-023 §4.1's EXISTS variant against
-- governance_role rather than proposal. The inserting citizen must be the
-- citizen_id of the governance_role referenced by approver_role_id, AND
-- that role's term must currently be active -- both the "acting as this
-- role" and the "role.term" condition from AUTH-010's approval:submit:*
-- rows are enforced by the same EXISTS check. AUTH-010's coi.none condition
-- is a runtime business-rule check (ARCH-023 §5), not enforced here --
-- application code, next phase.
CREATE POLICY approval_public_read ON approval FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY approval_own_role_insert ON approval FOR INSERT TO api_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM governance_role gr
    WHERE gr.id = approver_role_id
      AND gr.citizen_id = current_citizen_id()
      AND gr.term_start <= CURRENT_DATE
      AND gr.term_end >= CURRENT_DATE
  ));
CREATE POLICY approval_worker_all ON approval FOR ALL TO api_worker
  USING (true) WITH CHECK (true);
