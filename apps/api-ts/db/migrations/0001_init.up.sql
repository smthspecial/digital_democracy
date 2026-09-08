-- 0001_init for api-ts (ADR-027, ADR-028): placeholder. The api-ts app owns
-- one database (api_ts) but no tables yet — service implementations
-- (SRV-001…007, SRV-009, SRV-011, SRV-013…016, SRV-018) land as follow-up
-- work, each bringing its tables into this file's successor migrations.
-- Intentionally a comment-only migration: runners apply it as a no-op while
-- schema_migrations-equivalent tracking stays honest about what ran.
SELECT 1;
