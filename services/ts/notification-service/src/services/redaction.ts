const BANNED_KEYS = new Set([
  "ballot_choice",
  "legal_identity",
  "government_id",
  "legal_identity_hash",
  "raw_legal_identifier",
]);

// Recursively scans a notification payload for keys that could leak private data (SRV-015: ballot
// choices, legal identity, or government identifiers must never enter a notification payload).
// Returns the offending key (as written by the caller) so the caller can reject with a useful message.
export function findBannedKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBannedKey(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (BANNED_KEYS.has(key.toLowerCase())) {
        return key;
      }
      const found = findBannedKey(nested);
      if (found !== undefined) {
        return found;
      }
    }
  }

  return undefined;
}
