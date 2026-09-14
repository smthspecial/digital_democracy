-- Local-dev Postgres bootstrap for compose (ADR-026, ARCH-025 §4, ADR-028).
--
-- One shared Postgres *server* for local dev, one *database* per app
-- (ADR-028): api_go holds all four Go services' tables (apps/api-go,
-- migrated automatically at boot via ADR-029); api_ts will hold the
-- TypeScript services' tables once those implementations land
-- (apps/api-ts, currently a shell with no tables).
--
-- IMPORTANT: api-ts connects to an empty database today; api-go runs its
-- migration on first connect. Role separation (api_app/api_worker) is
-- enforced by the migration's GRANTs/policies whenever those roles connect.

CREATE DATABASE api_go;
CREATE DATABASE api_ts;
