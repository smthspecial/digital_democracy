/*
  Warnings:

  - Added the required column `evidence_ref` to the `competency` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "competency_stage" AS ENUM ('intake', 'credential_verification', 'public_review', 'domain_peer_review', 'decided');

-- CreateEnum
CREATE TYPE "stage_review_decision" AS ENUM ('passed', 'failed');

-- AlterTable
-- Nullable-then-backfill-then-NOT-NULL: safe against any pre-existing rows
-- (e.g. seeded via admin connection in earlier tests/dev use), unlike a
-- direct ADD COLUMN ... NOT NULL with no default.
ALTER TABLE "competency" ADD COLUMN     "evidence_ref" TEXT,
ADD COLUMN     "stage" "competency_stage" NOT NULL DEFAULT 'intake';
UPDATE "competency" SET "evidence_ref" = '' WHERE "evidence_ref" IS NULL;
ALTER TABLE "competency" ALTER COLUMN "evidence_ref" SET NOT NULL;

-- CreateTable
CREATE TABLE "competency_stage_review" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competency_id" UUID NOT NULL,
    "stage" "competency_stage" NOT NULL,
    "reviewer_id" UUID,
    "decision" "stage_review_decision" NOT NULL,
    "notes" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competency_stage_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competency_stage_review_competency_id_idx" ON "competency_stage_review"("competency_id");

-- AddForeignKey
ALTER TABLE "competency_stage_review" ADD CONSTRAINT "competency_stage_review_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- E4-04/ADR-037: one live claim per (citizen, domain) -- a partial unique
-- index, same shape as citizen_legal_identity_hash_active_uidx. "Live"
-- means applied or active; rejected/expired/revoked can be re-applied for.
CREATE UNIQUE INDEX competency_citizen_domain_live_uidx ON competency (citizen_id, domain_id)
  WHERE status IN ('applied', 'active');

GRANT SELECT, INSERT, UPDATE ON competency_stage_review TO api_app, api_worker;
ALTER TABLE competency_stage_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE competency_stage_review FORCE ROW LEVEL SECURITY;

-- competency_stage_review -- PUBLIC read (pipeline transparency, same
-- rationale as approval/governance_role); worker-only write (the pipeline
-- advances via CompetencyPipelineService, a worker-scoped service call).
CREATE POLICY competency_stage_review_public_read ON competency_stage_review FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY competency_stage_review_worker_all ON competency_stage_review FOR ALL TO api_worker
  USING (true) WITH CHECK (true);
