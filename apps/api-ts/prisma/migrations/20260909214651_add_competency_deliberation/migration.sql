-- CreateEnum
CREATE TYPE "competency_status" AS ENUM ('applied', 'active', 'rejected', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "competency_challenge_reason" AS ENUM ('credentials', 'conflict', 'false_claim', 'misconduct');

-- CreateEnum
CREATE TYPE "competency_challenge_status" AS ENUM ('open', 'reviewing', 'upheld', 'dismissed');

-- CreateEnum
CREATE TYPE "conflict_of_interest_type" AS ENUM ('employer', 'ownership', 'consulting', 'financial');

-- CreateEnum
CREATE TYPE "deliberation_stance" AS ENUM ('agreement', 'disagreement');

-- CreateTable
CREATE TABLE "expert_domain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "expert_domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "level" SMALLINT NOT NULL,
    "status" "competency_status" NOT NULL DEFAULT 'applied',
    "granted_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "competency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_challenge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competency_id" UUID NOT NULL,
    "challenger_id" UUID NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "reason" "competency_challenge_reason" NOT NULL,
    "status" "competency_challenge_status" NOT NULL DEFAULT 'open',
    "decision" TEXT,

    CONSTRAINT "competency_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflict_of_interest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "type" "conflict_of_interest_type" NOT NULL,
    "description" TEXT NOT NULL,
    "disclosed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conflict_of_interest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expert_assessment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "expert_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "technical_score" SMALLINT NOT NULL,
    "economic_score" SMALLINT NOT NULL,
    "social_score" SMALLINT NOT NULL,
    "sustainability_score" SMALLINT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expert_assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliberation_argument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "parent_id" UUID,
    "stance" "deliberation_stance" NOT NULL,
    "body" TEXT NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deliberation_argument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preference" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "problem_id" UUID NOT NULL,
    "desired_outcome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competency_citizen_id_idx" ON "competency"("citizen_id");

-- CreateIndex
CREATE INDEX "competency_domain_id_idx" ON "competency"("domain_id");

-- CreateIndex
CREATE INDEX "competency_challenge_competency_id_idx" ON "competency_challenge"("competency_id");

-- CreateIndex
CREATE INDEX "conflict_of_interest_citizen_id_idx" ON "conflict_of_interest"("citizen_id");

-- CreateIndex
CREATE INDEX "conflict_of_interest_domain_id_idx" ON "conflict_of_interest"("domain_id");

-- CreateIndex
CREATE INDEX "expert_assessment_proposal_id_idx" ON "expert_assessment"("proposal_id");

-- CreateIndex
CREATE INDEX "expert_assessment_expert_id_idx" ON "expert_assessment"("expert_id");

-- CreateIndex
CREATE INDEX "expert_assessment_domain_id_idx" ON "expert_assessment"("domain_id");

-- CreateIndex
CREATE INDEX "deliberation_argument_proposal_id_idx" ON "deliberation_argument"("proposal_id");

-- CreateIndex
CREATE INDEX "deliberation_argument_author_id_idx" ON "deliberation_argument"("author_id");

-- CreateIndex
CREATE INDEX "deliberation_argument_parent_id_idx" ON "deliberation_argument"("parent_id");

-- CreateIndex
CREATE INDEX "preference_citizen_id_idx" ON "preference"("citizen_id");

-- CreateIndex
CREATE INDEX "preference_problem_id_idx" ON "preference"("problem_id");

-- AddForeignKey
ALTER TABLE "competency" ADD CONSTRAINT "competency_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency" ADD CONSTRAINT "competency_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "expert_domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_challenge" ADD CONSTRAINT "competency_challenge_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_challenge" ADD CONSTRAINT "competency_challenge_challenger_id_fkey" FOREIGN KEY ("challenger_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflict_of_interest" ADD CONSTRAINT "conflict_of_interest_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflict_of_interest" ADD CONSTRAINT "conflict_of_interest_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "expert_domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_assessment" ADD CONSTRAINT "expert_assessment_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_assessment" ADD CONSTRAINT "expert_assessment_expert_id_fkey" FOREIGN KEY ("expert_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_assessment" ADD CONSTRAINT "expert_assessment_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "expert_domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliberation_argument" ADD CONSTRAINT "deliberation_argument_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliberation_argument" ADD CONSTRAINT "deliberation_argument_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliberation_argument" ADD CONSTRAINT "deliberation_argument_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "deliberation_argument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preference" ADD CONSTRAINT "preference_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preference" ADD CONSTRAINT "preference_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (ADR-024, ARCH-023, adapted to app-level roles per
-- ADR-028) and DB-level consistency, for TBL-011..015, TBL-017, TBL-018
-- (competency-service/SRV-005, deliberation-service/SRV-006). Roles and
-- current_citizen_id() already exist (20260909071102_init) -- this migration
-- only grants and adds policies for the seven new tables.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON
  expert_domain, competency, competency_challenge, conflict_of_interest,
  expert_assessment, deliberation_argument, preference
  TO api_app, api_worker;

-- §4: RLS enabled + forced on every table, no exceptions.
ALTER TABLE expert_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE expert_domain FORCE ROW LEVEL SECURITY;
ALTER TABLE competency ENABLE ROW LEVEL SECURITY;
ALTER TABLE competency FORCE ROW LEVEL SECURITY;
ALTER TABLE competency_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE competency_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE conflict_of_interest ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_of_interest FORCE ROW LEVEL SECURITY;
ALTER TABLE expert_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE expert_assessment FORCE ROW LEVEL SECURITY;
ALTER TABLE deliberation_argument ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliberation_argument FORCE ROW LEVEL SECURITY;
ALTER TABLE preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE preference FORCE ROW LEVEL SECURITY;

-- expert_domain -- PUBLIC read; write _worker only (reference data, mirrors
-- jurisdiction; no citizen-facing write in this pass).
CREATE POLICY expert_domain_public_read ON expert_domain FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY expert_domain_worker_insert ON expert_domain FOR INSERT TO api_worker
  WITH CHECK (true);
CREATE POLICY expert_domain_worker_update ON expert_domain FOR UPDATE TO api_worker
  USING (true) WITH CHECK (true);

-- competency -- PUBLIC read + OWN insert (citizen_id = current_citizen_id());
-- no _app UPDATE policy -- activation/expiry/revocation are all async/cron
-- (DP-031/DP-032/DP-044), out of scope this pass, done via api_worker.
CREATE POLICY competency_public_read ON competency FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY competency_own_insert ON competency FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY competency_worker_all ON competency FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- competency_challenge -- PUBLIC read + authenticated insert as challenger.
-- challenger_id, not citizen_id: the challenger is not this row's "subject"
-- (that's the challenged competency's own citizen_id).
CREATE POLICY competency_challenge_public_read ON competency_challenge FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY competency_challenge_own_insert ON competency_challenge FOR INSERT TO api_app
  WITH CHECK (challenger_id = current_citizen_id());
CREATE POLICY competency_challenge_worker_all ON competency_challenge FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- conflict_of_interest -- read visibility: ARCH-023 §6 labels this table
-- plain "OWN" (which, taken literally per §4.1, would also make SELECT
-- citizen-private), but TBL-014.md's own Notes ("Public alongside expert
-- analysis") and FR-025's acceptance criteria ("Disclosures are publicly
-- visible alongside expert analysis") say otherwise -- TBL-014.md/FR-025
-- win: PUBLIC read. The "OWN" in ARCH-023 §6 describes only the INSERT
-- restriction (self-disclosure only), not a read restriction. Per AUTH-010's
-- actual coi:declare row (scope own, condition citizen.active only -- no
-- competency requirement, despite DP-010's stricter "citizen with active
-- competency" actor line), the INSERT policy below is NOT scoped to require
-- an existing competency row.
CREATE POLICY conflict_of_interest_public_read ON conflict_of_interest FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY conflict_of_interest_own_insert ON conflict_of_interest FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY conflict_of_interest_worker_all ON conflict_of_interest FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- expert_assessment -- PUBLIC read + local domain-match write (§4.1 variant:
-- domain:match against competency.citizen_id/domain_id/status='active',
-- same database). AUTH-002's coi.none ("no active conflict_of_interest in
-- the relevant domain") is NOT enforced here -- a conflict_of_interest row
-- IS the disclosure record itself (no separate disclosed/undisclosed flag),
-- so any existing row for (expert, domain) blocks assessment:publish, but
-- that is a runtime business-rule condition (ARCH-023 §5), not a row-
-- visibility check; it belongs in application code (competency module, next
-- phase), not this INSERT policy.
CREATE POLICY expert_assessment_public_read ON expert_assessment FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY expert_assessment_domain_match_insert ON expert_assessment FOR INSERT TO api_app
  WITH CHECK (
    expert_id = current_citizen_id()
    AND EXISTS (
      SELECT 1 FROM competency c
      WHERE c.citizen_id = current_citizen_id()
        AND c.domain_id = expert_assessment.domain_id
        AND c.status = 'active'
    )
  );
CREATE POLICY expert_assessment_worker_all ON expert_assessment FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- deliberation_argument -- PUBLIC read; _app INSERT any active citizen as
-- author (DP-008).
CREATE POLICY deliberation_argument_public_read ON deliberation_argument FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY deliberation_argument_own_insert ON deliberation_argument FOR INSERT TO api_app
  WITH CHECK (author_id = current_citizen_id());
CREATE POLICY deliberation_argument_worker_all ON deliberation_argument FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- preference -- PUBLIC read + OWN insert (DP-009). problem_id, not
-- proposal_id: ARCH-023 §6 and AUTH-010's "preference:declare...on a
-- proposal" both say "proposal", but TBL-018.md's own front matter/columns
-- and DP-009.md/SRV-006.md's prose ("tied to the problem, not a particular
-- proposal") say problem_id -- TBL-018.md, the authoritative schema source,
-- wins (see schema.prisma's matching comment on the Preference model). No
-- uniqueness constraint on (problem_id, citizen_id) either -- nothing in
-- TBL-018.md/DP-009.md/FR-030.md states one-preference-per-citizen-per-
-- problem.
CREATE POLICY preference_public_read ON preference FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY preference_own_insert ON preference FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY preference_worker_all ON preference FOR ALL TO api_worker
  USING (true) WITH CHECK (true);
