export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.APP_ENV !== "production") return;
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("Production TLS verification cannot be disabled");
  if (env.MIGRATE_DATABASE_URL) throw new Error("Migration credentials must not be supplied to runtime");
  for (const key of ["DATABASE_URL", "WORKER_DATABASE_URL"]) {
    let url: URL;
    try { url = new URL(env[key] ?? ""); } catch { throw new Error(`Production ${key} requires a valid database URL`); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.searchParams.getAll("sslmode").length !== 1 || url.searchParams.get("sslmode") !== "verify-full") {
      throw new Error(`Production ${key} requires sslmode=verify-full`);
    }
  }
  for (const key of ["INTERNAL_SERVICE_SHARED_SECRET", "IDENTITY_VERIFIER_SHARED_SECRET", "IDENTITY_HASH_SECRET"]) {
    if ((env[key]?.length ?? 0) < 32) throw new Error(`Production ${key} requires at least 32 characters`);
  }
  for (const key of ["AUTH_SERVICE_URL", "AUDIT_SERVICE_URL"]) {
    let url: URL;
    try { url = new URL(env[key] ?? ""); } catch { throw new Error(`Production ${key} requires a service address`); }
    if (url.username || url.password || (url.protocol !== "https:" && (url.protocol !== "http:" || !url.hostname.endsWith(".svc.cluster.local")))) {
      throw new Error(`Production ${key} requires HTTPS or a mesh-local address`);
    }
  }
}
