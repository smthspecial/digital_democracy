-- Local-dev Postgres bootstrap for docker-compose (ADR-026, ARCH-025 §4).
--
-- One shared Postgres *server* for local dev, one *database* per service
-- that already has a real migration under services/*/*/db/migrations/ --
-- this keeps ADR-015's database-per-service isolation boundary intact
-- without running 17 separate Postgres containers on a laptop.
--
-- IMPORTANT: no service actually connects to any of these databases yet --
-- every service still runs its own in-memory store (none of the .env.example
-- files below define a DATABASE_URL). This is forward-compatible scaffolding
-- only, matching the pattern infra/helm/values/*.yaml already sets for
-- dependencies a service doesn't use yet. Each database is named to match
-- that service's own migration's role prefix (<name>_app / <name>_worker,
-- ARCH-023 §2), so wiring a service to Postgres later is "point
-- DATABASE_URL at this database and run its migration", not "provision a
-- database".
--
-- Services with no migration yet -- notification-service, ai-synthesis-service
-- -- have no database created here. Add one (and re-derive this list) once a
-- migration exists under their db/migrations/.

CREATE DATABASE audit;
CREATE DATABASE auth;
CREATE DATABASE delegation;
CREATE DATABASE voting;
CREATE DATABASE budget;
CREATE DATABASE civic_duty;
CREATE DATABASE competency;
CREATE DATABASE deliberation;
CREATE DATABASE governance_role;
CREATE DATABASE iam;
CREATE DATABASE identity;
CREATE DATABASE jurisdiction;
CREATE DATABASE problem;
CREATE DATABASE project;
CREATE DATABASE proposal;
CREATE DATABASE reputation;
