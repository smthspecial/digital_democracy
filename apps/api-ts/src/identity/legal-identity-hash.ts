import { createHmac } from "node:crypto";

// tbl-001.md: "Salted hash binding to a verified legal identity; raw
// identifiers never stored here." The raw legal identifier (e.g. a national
// ID number) is hashed server-side with a secret pepper and never persisted
// or logged -- only the hash reaches the repository layer.
export function hashLegalIdentifier(rawIdentifier: string): string {
  const secret = process.env.IDENTITY_HASH_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: IDENTITY_HASH_SECRET");
  }
  return createHmac("sha256", secret).update(rawIdentifier).digest("hex");
}
