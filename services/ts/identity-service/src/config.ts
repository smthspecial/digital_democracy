export const config = {
  port: Number(process.env.PORT ?? 4001),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/identity_service",
  // Pepper for TBL-001.legal_identity_hash (see src/hash.ts). Must be set to
  // a real secret, managed via the External Secrets Operator (ARCH-006), in
  // every deployed environment.
  identityHashSecret: process.env.IDENTITY_HASH_SECRET ?? "dev-insecure-secret-change-me",
};
