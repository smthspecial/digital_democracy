-- SRV-013 project-service — reverse of 0001_init.up.sql, dependency order.

-- 1. Tables (drops their policies, indexes, and constraints with them).
-- Children before parent to respect the FK from project_milestone/
-- outcome_evaluation back to project, even though CASCADE would also
-- handle it.
DROP TABLE IF EXISTS outcome_evaluation CASCADE;
DROP TABLE IF EXISTS project_milestone CASCADE;
DROP TABLE IF EXISTS project CASCADE;

-- 2. Enum types.
DROP TYPE IF EXISTS evaluation_result;
DROP TYPE IF EXISTS milestone_status;
DROP TYPE IF EXISTS project_status;

-- 3. Session-context helper function.
DROP FUNCTION IF EXISTS current_citizen_id();

-- 4. Schema privileges and roles.
REVOKE ALL ON SCHEMA public FROM project_app, project_worker;
-- Best-effort restoration of the pre-migration default (public schema
-- readable/usable by PUBLIC); the exact prior grant state was not recorded.
GRANT ALL ON SCHEMA public TO PUBLIC;

DROP ROLE IF EXISTS project_app;
DROP ROLE IF EXISTS project_worker;
