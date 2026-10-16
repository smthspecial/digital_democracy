import { describe, expect, it } from "vitest";
import { validateProductionConfig } from "./production-config.js";
const valid = () => ({ APP_ENV: "production", DATABASE_URL: "postgres://app:secret@database/db?sslmode=verify-full", WORKER_DATABASE_URL: "postgres://worker:secret@database/db?sslmode=verify-full", INTERNAL_SERVICE_SHARED_SECRET: "a".repeat(32), IDENTITY_VERIFIER_SHARED_SECRET: "b".repeat(32), IDENTITY_HASH_SECRET: "c".repeat(32), AUTH_SERVICE_URL: "http://api-go.api-go.svc.cluster.local:8080", AUDIT_SERVICE_URL: "http://api-go.api-go.svc.cluster.local:8080" });
describe("production configuration", () => {
 it("allows verified connections and mesh-local seams", () => expect(() => validateProductionConfig(valid())).not.toThrow());
 it.each([ ["DATABASE_URL", "postgres://app:secret@host/db?sslmode=require"], ["DATABASE_URL", "postgres://app:secret@host/db?sslmode=verify-full&sslmode=disable"], ["WORKER_DATABASE_URL", "invalid-secret-url"], ["MIGRATE_DATABASE_URL", "admin-secret"], ["NODE_TLS_REJECT_UNAUTHORIZED", "0"], ["AUTH_SERVICE_URL", "http://external.example.org"], ["IDENTITY_HASH_SECRET", "test-secret"] ])("rejects unsafe %s without exposing its value", (key,value) => {
  expect(() => validateProductionConfig({ ...valid(), [key]: value })).toThrow();
  try { validateProductionConfig({ ...valid(), [key]: value }); } catch(error) { expect(String(error)).not.toContain(value); }
 });
 it("keeps isolated development fixtures available", () => expect(() => validateProductionConfig({ APP_ENV:"development" })).not.toThrow());
});
