-- CreateEnum
CREATE TYPE "ledger_direction" AS ENUM ('inflow', 'outflow');

-- CreateTable
CREATE TABLE "budget_category" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "jurisdiction_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "allocated_amount" DECIMAL(14,2),

    CONSTRAINT "budget_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_allocation_vote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "citizen_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "period" TEXT NOT NULL,

    CONSTRAINT "budget_allocation_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "jurisdiction_id" UUID NOT NULL,
    "category_id" UUID,
    "project_id" UUID,
    "direction" "ledger_direction" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "source" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "budget_category_jurisdiction_id_idx" ON "budget_category"("jurisdiction_id");

-- CreateIndex
CREATE INDEX "budget_category_parent_id_idx" ON "budget_category"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_allocation_vote_citizen_id_category_id_period_key" ON "budget_allocation_vote"("citizen_id", "category_id", "period");

-- CreateIndex
CREATE INDEX "budget_allocation_vote_category_id_idx" ON "budget_allocation_vote"("category_id");

-- CreateIndex
CREATE INDEX "ledger_entry_jurisdiction_id_idx" ON "ledger_entry"("jurisdiction_id");

-- CreateIndex
CREATE INDEX "ledger_entry_category_id_idx" ON "ledger_entry"("category_id");

-- AddForeignKey
ALTER TABLE "budget_category" ADD CONSTRAINT "budget_category_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdiction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_category" ADD CONSTRAINT "budget_category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "budget_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_allocation_vote" ADD CONSTRAINT "budget_allocation_vote_citizen_id_fkey" FOREIGN KEY ("citizen_id") REFERENCES "citizen"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_allocation_vote" ADD CONSTRAINT "budget_allocation_vote_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "budget_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdiction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "budget_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (ADR-024, ARCH-023, adapted to app-level roles per
-- ADR-028) and DB-level consistency, for TBL-026..028 (budget-service/
-- SRV-007). Roles and current_citizen_id() already exist
-- (20260909071102_init) -- this migration only grants and adds policies for
-- the three new tables.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON
  budget_category, budget_allocation_vote, ledger_entry
  TO api_app, api_worker;

-- budget_allocation_vote's transactional replace-the-set write (SRV-007.md:
-- "budget_allocation_vote is unique per (citizen_id, category_id, period)"
-- and "Totals per citizen per period must sum to 100%; enforced at write
-- time" -- a cross-row invariant spanning multiple category_id rows for the
-- same (citizen_id, period), so DP-013 deletes a citizen's existing rows for
-- that period and inserts the full new set inside one transaction rather
-- than upserting row-by-row) needs a real DELETE privilege, which §2's
-- default blanket GRANT above deliberately excludes ("Neither role is ever
-- granted DELETE on any table in this pass... grant it explicitly on that
-- table rather than widening the default").
GRANT DELETE ON budget_allocation_vote TO api_app, api_worker;

-- §4: RLS enabled + forced on every table, no exceptions.
ALTER TABLE budget_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_category FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_allocation_vote ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_allocation_vote FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry FORCE ROW LEVEL SECURITY;

-- budget_category -- PUBLIC read; write _worker only (reference data,
-- mirrors jurisdiction/expert_domain; no citizen-facing write in this pass).
CREATE POLICY budget_category_public_read ON budget_category FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY budget_category_worker_insert ON budget_category FOR INSERT TO api_worker
  WITH CHECK (true);
CREATE POLICY budget_category_worker_update ON budget_category FOR UPDATE TO api_worker
  USING (true) WITH CHECK (true);

-- budget_allocation_vote -- ARCH-023 §6 marks this table OWN for BOTH read
-- and write ("treated as vote-adjacent, defaults private like a ballot
-- rather than public") -- deliberately NOT public read, unlike every other
-- citizen-write table in this schema (problem_support, proposal,
-- deliberation_argument, preference, competency, conflict_of_interest).
-- Only the DP-051 aggregate written to budget_category.allocated_amount is
-- public (FR-038's "Allocation results are public" AC is about the
-- aggregate, not individual vote rows). §4.1's OWN template for all three
-- of its listed operations, PLUS an explicit DELETE policy (not in §4.1's
-- template) -- needed because DP-013's write replaces a citizen's full
-- allocation set for a period (delete old rows, insert the new set) rather
-- than upserting one row at a time, since the 100%-total invariant spans
-- multiple category_id rows and can never be safely enforced by a
-- single-row upsert.
CREATE POLICY budget_allocation_vote_own_select ON budget_allocation_vote FOR SELECT TO api_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY budget_allocation_vote_own_insert ON budget_allocation_vote FOR INSERT TO api_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY budget_allocation_vote_own_update ON budget_allocation_vote FOR UPDATE TO api_app
  USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY budget_allocation_vote_own_delete ON budget_allocation_vote FOR DELETE TO api_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY budget_allocation_vote_worker_all ON budget_allocation_vote FOR ALL TO api_worker
  USING (true) WITH CHECK (true);

-- ledger_entry -- the first APPEND_ONLY table (§4.4) in this schema. PUBLIC
-- read (FR-036's real-time public ledger, both roles); api_worker-only
-- INSERT (AUTH-006's ledger_entry:record is an operator permission, not a
-- citizen one -- enforced via iam-service's policy engine per AUTH-006's
-- own text, and there is no operator-auth mechanism anywhere in this app
-- yet, unlike the citizen header seam ADR-030 deliberately established as
-- an interim stand-in -- so no api_app write policy of any kind exists
-- here). No UPDATE/DELETE for either role: REVOKE the UPDATE this
-- migration's blanket GRANT above just granted (DELETE was never granted to
-- begin with, per §2 -- the REVOKE DELETE below is belt-and-suspenders,
-- matching §4.4's literal text exactly), plus the full trigger pattern,
-- which also stops the migrator/table-owner role (never subject to
-- REVOKEd grants on its own objects) from mutating history by accident.
REVOKE UPDATE, DELETE ON ledger_entry FROM api_app, api_worker;

CREATE OR REPLACE FUNCTION ledger_entry_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only: % not permitted', TG_OP;
END;
$$;
CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_forbid_mutation();
CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_forbid_mutation();

CREATE POLICY ledger_entry_public_read ON ledger_entry FOR SELECT TO api_app, api_worker
  USING (true);
CREATE POLICY ledger_entry_worker_insert ON ledger_entry FOR INSERT TO api_worker
  WITH CHECK (true);
