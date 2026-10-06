CREATE TYPE "residency_verification_decision" AS ENUM ('verified', 'rejected');

ALTER TABLE "residency"
  ADD COLUMN "verification_decision" "residency_verification_decision",
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "reviewed_by_citizen_id" UUID;

ALTER TABLE "residency"
  ADD CONSTRAINT "residency_reviewed_by_citizen_id_fkey"
  FOREIGN KEY ("reviewed_by_citizen_id") REFERENCES "citizen"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "residency_reviewed_by_citizen_id_idx" ON "residency"("reviewed_by_citizen_id");
