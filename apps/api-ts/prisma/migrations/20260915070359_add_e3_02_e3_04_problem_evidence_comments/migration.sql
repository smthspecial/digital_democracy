-- CreateEnum
CREATE TYPE "problem_evidence_kind" AS ENUM ('document', 'link', 'statement');

-- CreateTable
CREATE TABLE "problem_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "problem_id" UUID NOT NULL,
    "citizen_id" UUID NOT NULL,
    "kind" "problem_evidence_kind" NOT NULL,
    "ref" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem_comment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "problem_id" UUID NOT NULL,
    "citizen_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "problem_evidence_problem_id_idx" ON "problem_evidence"("problem_id");

-- CreateIndex
CREATE INDEX "problem_comment_problem_id_idx" ON "problem_comment"("problem_id");

-- AddForeignKey
ALTER TABLE "problem_evidence" ADD CONSTRAINT "problem_evidence_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_evidence" ADD CONSTRAINT "problem_evidence_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_comment" ADD CONSTRAINT "problem_comment_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_comment" ADD CONSTRAINT "problem_comment_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT ON problem_evidence, problem_comment TO api_app, api_worker;
ALTER TABLE problem_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE problem_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem_comment FORCE ROW LEVEL SECURITY;

-- Same shape as problem_support: PUBLIC read, OWN insert.
CREATE POLICY problem_evidence_public_read ON problem_evidence FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY problem_evidence_own_insert ON problem_evidence FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY problem_comment_public_read ON problem_comment FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY problem_comment_own_insert ON problem_comment FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
