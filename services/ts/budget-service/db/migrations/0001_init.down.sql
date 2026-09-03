-- 0001_init.down.sql — budget-service (SRV-007)
-- Reverses 0001_init.up.sql in dependency order: triggers/functions, tables,
-- types, roles, schema privileges.

-- 1. Append-only trigger + function (ledger_entry)
DROP TRIGGER IF EXISTS ledger_entry_no_delete ON ledger_entry;
DROP TRIGGER IF EXISTS ledger_entry_no_update ON ledger_entry;
DROP FUNCTION IF EXISTS ledger_entry_forbid_mutation();

-- 2. Tables (child-before-parent: ledger_entry and budget_allocation_vote
--    both FK to budget_category; budget_category self-references itself)
DROP TABLE IF EXISTS ledger_entry;
DROP TABLE IF EXISTS budget_allocation_vote;
DROP TABLE IF EXISTS budget_category;

-- 3. Session-context helper
DROP FUNCTION IF EXISTS current_citizen_id();

-- 4. Enum types
DROP TYPE IF EXISTS ledger_entry_direction;

-- 5. Roles + schema privileges
REVOKE ALL ON SCHEMA public FROM budget_app, budget_worker;

DROP ROLE IF EXISTS budget_app;
DROP ROLE IF EXISTS budget_worker;

GRANT ALL ON SCHEMA public TO PUBLIC;
