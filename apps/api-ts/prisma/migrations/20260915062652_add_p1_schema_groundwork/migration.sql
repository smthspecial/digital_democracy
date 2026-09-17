-- CreateEnum
CREATE TYPE "identity_revocation_reason" AS ENUM ('death', 'loss_of_citizenship', 'proven_fraud');

-- CreateEnum
CREATE TYPE "identity_revocation_status" AS ENUM ('pending', 'approved', 'executed', 'rejected');

-- CreateEnum
CREATE TYPE "scope_challenge_status" AS ENUM ('open', 'upheld', 'dismissed');

-- CreateEnum
CREATE TYPE "deadlock_stage" AS ENUM ('constraint_analysis', 'alternative_generation', 'resource_partitioning', 'compensation_assessment', 'citizen_assembly_review', 'escalation_review', 'constitutional_review', 'final_decision');

-- AlterTable
ALTER TABLE "conflict_of_interest" ADD COLUMN     "related_citizen_id" UUID;

-- AlterTable
ALTER TABLE "deliberation_argument" ADD COLUMN     "locked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "locked_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "jurisdiction" ADD COLUMN     "min_residency_days" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "proposal" ADD COLUMN     "deadlock_active" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deadlock_stage" "deadlock_stage",
ADD COLUMN     "implementation_timeline" TEXT,
ADD COLUMN     "measurable_outcomes" TEXT,
ADD COLUMN     "objectives" TEXT,
ADD COLUMN     "scope_escalation_reason" TEXT,
ADD COLUMN     "scope_rationale" TEXT;

-- CreateTable
CREATE TABLE "identity_revocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "reason" "identity_revocation_reason" NOT NULL,
    "justification" TEXT NOT NULL,
    "action_ref" TEXT NOT NULL,
    "status" "identity_revocation_status" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMP(3),

    CONSTRAINT "identity_revocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scope_challenge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "challenger_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "scope_challenge_status" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "scope_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deadlock_history_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "stage" "deadlock_stage" NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "notes" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deadlock_history_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_revocation_citizen_id_idx" ON "identity_revocation"("citizen_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_revocation_action_ref_key" ON "identity_revocation"("action_ref");

-- CreateIndex
CREATE INDEX "scope_challenge_proposal_id_idx" ON "scope_challenge"("proposal_id");

-- CreateIndex
CREATE INDEX "scope_challenge_challenger_id_idx" ON "scope_challenge"("challenger_id");

-- CreateIndex
CREATE INDEX "deadlock_history_entry_proposal_id_idx" ON "deadlock_history_entry"("proposal_id");

-- CreateIndex
CREATE INDEX "conflict_of_interest_related_citizen_id_idx" ON "conflict_of_interest"("related_citizen_id");

-- AddForeignKey
ALTER TABLE "identity_revocation" ADD CONSTRAINT "identity_revocation_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scope_challenge" ADD CONSTRAINT "scope_challenge_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scope_challenge" ADD CONSTRAINT "scope_challenge_challenger_id_fkey" FOREIGN KEY ("challenger_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadlock_history_entry" ADD CONSTRAINT "deadlock_history_entry_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflict_of_interest" ADD CONSTRAINT "conflict_of_interest_related_citizen_id_fkey" FOREIGN KEY ("related_citizen_id") REFERENCES "citizen"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security for the three new tables (existing tables' new columns
-- inherit their table's existing policies automatically).
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON
  identity_revocation, scope_challenge, deadlock_history_entry
  TO api_app, api_worker;

ALTER TABLE identity_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_revocation FORCE ROW LEVEL SECURITY;
ALTER TABLE scope_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE deadlock_history_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE deadlock_history_entry FORCE ROW LEVEL SECURITY;

-- identity_revocation -- PUBLIC read (FR-007/CON-005 transparency);
-- worker-only write (ADR-034 D4: requested by an operator-role actor via
-- the approval gate, not a raw citizen self-service insert).
CREATE POLICY identity_revocation_public_read ON identity_revocation FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY identity_revocation_worker_all ON identity_revocation FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- scope_challenge -- PUBLIC read (scope-dispute-resolution-is-public);
-- citizen files their own challenge, worker resolves it.
CREATE POLICY scope_challenge_public_read ON scope_challenge FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY scope_challenge_own_insert ON scope_challenge FOR INSERT TO api_app
  WITH CHECK (challenger_id = current_citizen_id());
CREATE POLICY scope_challenge_worker_all ON scope_challenge FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- deadlock_history_entry -- PUBLIC read (transparency of the deadlock
-- process); worker-only write (the assigned reviewer's advance goes through
-- a worker-scoped service call, ADR-036 D35).
CREATE POLICY deadlock_history_public_read ON deadlock_history_entry FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY deadlock_history_worker_all ON deadlock_history_entry FOR ALL TO api_worker
  USING (true) WITH CHECK (true);
