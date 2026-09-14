-- CreateEnum
CREATE TYPE "citizenship_status" AS ENUM ('citizen', 'revoked', 'suspended');

-- CreateEnum
CREATE TYPE "citizen_status" AS ENUM ('pending', 'active', 'inactive', 'revoked');

-- CreateEnum
CREATE TYPE "verification_method" AS ENUM ('national_id', 'passport', 'gov_credential');

-- CreateEnum
CREATE TYPE "verification_status" AS ENUM ('verified', 'rejected');

-- CreateEnum
CREATE TYPE "jurisdiction_scope_level" AS ENUM ('property', 'street', 'municipality', 'regional', 'national', 'constitutional');

-- CreateEnum
CREATE TYPE "jurisdiction_status" AS ENUM ('active', 'under_review');

-- CreateEnum
CREATE TYPE "residency_status" AS ENUM ('active', 'ended');

-- CreateEnum
CREATE TYPE "problem_status" AS ENUM ('open', 'proposing', 'closed');

-- CreateEnum
CREATE TYPE "proposal_status" AS ENUM ('draft', 'gathering_support', 'development', 'voting', 'approved', 'rejected', 'archived');

-- CreateTable
CREATE TABLE "citizen" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "public_handle" TEXT NOT NULL,
    "citizenship_status" "citizenship_status" NOT NULL DEFAULT 'citizen',
    "legal_identity_hash" TEXT NOT NULL,
    "status" "citizen_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citizen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_verification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "method" "verification_method" NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3),
    "status" "verification_status" NOT NULL,

    CONSTRAINT "identity_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jurisdiction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "scope_level" "jurisdiction_scope_level" NOT NULL,
    "boundary_ref" TEXT NOT NULL,
    "status" "jurisdiction_status" NOT NULL DEFAULT 'active',

    CONSTRAINT "jurisdiction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residency" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "jurisdiction_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "status" "residency_status" NOT NULL DEFAULT 'active',

    CONSTRAINT "residency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jurisdiction_membership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "jurisdiction_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jurisdiction_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "author_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "affected_area" TEXT NOT NULL,
    "jurisdiction_id" UUID NOT NULL,
    "status" "problem_status" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem_support" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "problem_id" UUID NOT NULL,
    "citizen_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_support_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "problem_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "scope_jurisdiction_id" UUID,
    "support_count" INTEGER NOT NULL DEFAULT 0,
    "support_threshold" INTEGER NOT NULL,
    "status" "proposal_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_constraint" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "agreed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "proposal_constraint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_budget" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "cost" DECIMAL(14,2),
    "funding_source" TEXT,
    "funding_category_id" UUID,
    "maintenance_cost" DECIMAL(14,2),
    "long_term_cost" DECIMAL(14,2),
    "expected_benefits" TEXT,

    CONSTRAINT "proposal_budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "citizen_public_handle_key" ON "citizen"("public_handle");

-- CreateIndex
CREATE INDEX "citizen_legal_identity_hash_idx" ON "citizen"("legal_identity_hash");

-- CreateIndex
CREATE INDEX "identity_verification_citizen_id_idx" ON "identity_verification"("citizen_id");

-- CreateIndex
CREATE INDEX "residency_citizen_id_idx" ON "residency"("citizen_id");

-- CreateIndex
CREATE INDEX "residency_jurisdiction_id_idx" ON "residency"("jurisdiction_id");

-- CreateIndex
CREATE UNIQUE INDEX "jurisdiction_membership_citizen_id_jurisdiction_id_key" ON "jurisdiction_membership"("citizen_id", "jurisdiction_id");

-- CreateIndex
CREATE INDEX "problem_jurisdiction_id_idx" ON "problem"("jurisdiction_id");

-- CreateIndex
CREATE UNIQUE INDEX "problem_support_problem_id_citizen_id_key" ON "problem_support"("problem_id", "citizen_id");

-- CreateIndex
CREATE INDEX "proposal_problem_id_idx" ON "proposal"("problem_id");

-- CreateIndex
CREATE INDEX "proposal_constraint_proposal_id_idx" ON "proposal_constraint"("proposal_id");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_budget_proposal_id_key" ON "proposal_budget"("proposal_id");

-- AddForeignKey
ALTER TABLE "identity_verification" ADD CONSTRAINT "identity_verification_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jurisdiction" ADD CONSTRAINT "jurisdiction_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "jurisdiction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residency" ADD CONSTRAINT "residency_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residency" ADD CONSTRAINT "residency_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdiction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jurisdiction_membership" ADD CONSTRAINT "jurisdiction_membership_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jurisdiction_membership" ADD CONSTRAINT "jurisdiction_membership_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdiction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem" ADD CONSTRAINT "problem_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem" ADD CONSTRAINT "problem_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdiction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_support" ADD CONSTRAINT "problem_support_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_support" ADD CONSTRAINT "problem_support_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_scope_jurisdiction_id_fkey" FOREIGN KEY ("scope_jurisdiction_id") REFERENCES "jurisdiction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_constraint" ADD CONSTRAINT "proposal_constraint_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_budget" ADD CONSTRAINT "proposal_budget_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (ADR-024, ARCH-023, adapted to app-level roles per
-- ADR-028) and DB-level consistency, for TBL-001..010 (ADR-030).
-- ---------------------------------------------------------------------------

-- §2 Roles. Dev-only passwords (matches the docker-compose `dd`/`dd`
-- convention) -- production credentials are provisioned out of band and are
-- not this migration's concern.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_app') THEN
    CREATE ROLE api_app LOGIN PASSWORD 'api_app_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_worker') THEN
    CREATE ROLE api_worker LOGIN PASSWORD 'api_worker_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO api_app, api_worker;
GRANT SELECT, INSERT, UPDATE ON
  citizen, identity_verification, jurisdiction, residency, jurisdiction_membership,
  problem, problem_support, proposal, proposal_constraint, proposal_budget
  TO api_app, api_worker;

-- §3 Session context. `<svc>_worker` connections never set app.citizen_id --
-- its policies (below) don't key off it.
CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- §4: RLS enabled + forced on every table, no exceptions.
ALTER TABLE citizen ENABLE ROW LEVEL SECURITY;
ALTER TABLE citizen FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_verification FORCE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction FORCE ROW LEVEL SECURITY;
ALTER TABLE residency ENABLE ROW LEVEL SECURITY;
ALTER TABLE residency FORCE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_membership FORCE ROW LEVEL SECURITY;
ALTER TABLE problem ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem FORCE ROW LEVEL SECURITY;
ALTER TABLE problem_support ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem_support FORCE ROW LEVEL SECURITY;
ALTER TABLE proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE proposal_constraint ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_constraint FORCE ROW LEVEL SECURITY;
ALTER TABLE proposal_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_budget FORCE ROW LEVEL SECURITY;

-- §6 classification: citizen -- OWN; _app INSERT unconditional
-- (self-registration, DP-001, unauthenticated).
CREATE POLICY citizen_own_select ON citizen FOR SELECT TO api_app
  USING (id = current_citizen_id());
CREATE POLICY citizen_self_register ON citizen FOR INSERT TO api_app
  WITH CHECK (true);
CREATE POLICY citizen_worker_all ON citizen FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- identity_verification -- OWN (citizen_id).
CREATE POLICY identity_verification_own_select ON identity_verification FOR SELECT TO api_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY identity_verification_own_insert ON identity_verification FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY identity_verification_worker_all ON identity_verification FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- jurisdiction -- PUBLIC read; write _worker only (administrative; no
-- citizen-facing create/update op is spec'd for this table -- ADR-030).
CREATE POLICY jurisdiction_public_read ON jurisdiction FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY jurisdiction_worker_write ON jurisdiction FOR INSERT TO api_worker
  WITH CHECK (true);
CREATE POLICY jurisdiction_worker_update ON jurisdiction FOR UPDATE TO api_worker
  USING (true) WITH CHECK (true);

-- residency -- OWN (citizen_id). No citizen-facing create op is spec'd
-- either (ADR-030) -- policy shape follows ARCH-023 §4.1 for when one lands.
CREATE POLICY residency_own_select ON residency FOR SELECT TO api_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY residency_own_insert ON residency FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY residency_own_update ON residency FOR UPDATE TO api_app
  USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY residency_worker_all ON residency FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- jurisdiction_membership -- OWN (citizen_id); same "no create op yet" note.
CREATE POLICY jurisdiction_membership_own_select ON jurisdiction_membership FOR SELECT TO api_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY jurisdiction_membership_own_insert ON jurisdiction_membership FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY jurisdiction_membership_worker_all ON jurisdiction_membership FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- problem -- PUBLIC read; _app INSERT as author (submitted_by/author_id =
-- current_citizen_id(); DP-003). No citizen-facing update op is spec'd.
CREATE POLICY problem_public_read ON problem FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY problem_own_insert ON problem FOR INSERT TO api_app
  WITH CHECK (author_id = current_citizen_id());
CREATE POLICY problem_worker_all ON problem FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- problem_support -- PUBLIC read + OWN insert (DP-004); unique per
-- (problem_id, citizen_id) already enforced by the unique index above.
CREATE POLICY problem_support_public_read ON problem_support FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY problem_support_own_insert ON problem_support FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY problem_support_worker_all ON problem_support FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- proposal -- PUBLIC read + OWN insert as author (DP-005). support_count/
-- status transitions (DP-028/029) are worker-only writes.
CREATE POLICY proposal_public_read ON proposal FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY proposal_own_insert ON proposal FOR INSERT TO api_app
  WITH CHECK (author_id = current_citizen_id());
CREATE POLICY proposal_worker_all ON proposal FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- proposal_constraint -- PUBLIC read + local-parent OWN write (§4.1 EXISTS
-- variant: proposal-service owns both `proposal` and `proposal_constraint`).
CREATE POLICY proposal_constraint_public_read ON proposal_constraint FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY proposal_constraint_own_insert ON proposal_constraint FOR INSERT TO api_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM proposal p WHERE p.id = proposal_id AND p.author_id = current_citizen_id()
  ));
CREATE POLICY proposal_constraint_worker_all ON proposal_constraint FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- proposal_budget -- PUBLIC read + local-parent OWN write, INSERT and UPDATE
-- (DP-007 is create-or-update).
CREATE POLICY proposal_budget_public_read ON proposal_budget FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY proposal_budget_own_insert ON proposal_budget FOR INSERT TO api_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM proposal p WHERE p.id = proposal_id AND p.author_id = current_citizen_id()
  ));
CREATE POLICY proposal_budget_own_update ON proposal_budget FOR UPDATE TO api_app
  USING (EXISTS (
    SELECT 1 FROM proposal p WHERE p.id = proposal_id AND p.author_id = current_citizen_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM proposal p WHERE p.id = proposal_id AND p.author_id = current_citizen_id()
  ));
CREATE POLICY proposal_budget_worker_all ON proposal_budget FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- FR-001 AC ("duplicate identity creation attempts are detected and
-- rejected"), DP-001 scope: DB-backed invariant, defense-in-depth alongside
-- the application-level check in IdentityService (ADR-030). Revoked
-- identities are excluded so a legitimately revoked+re-verified legal
-- identity is not permanently locked out.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX citizen_legal_identity_hash_active_uidx
  ON citizen (legal_identity_hash)
  WHERE status <> 'revoked';
