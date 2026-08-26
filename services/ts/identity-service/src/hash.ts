import { createHmac } from "node:crypto";

// TBL-001.legal_identity_hash: a salted hash binding to a verified legal
// identity. The raw identifier (national ID number, passport number, ...)
// is never persisted -- only this HMAC digest, keyed by a per-deployment
// secret (NFR-006).
export function hashLegalIdentifier(rawIdentifier: string, secret: string): string {
  return createHmac("sha256", secret).update(rawIdentifier).digest("hex");
}
