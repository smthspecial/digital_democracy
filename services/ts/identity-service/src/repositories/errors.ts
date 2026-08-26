// Thrown when a citizen insert violates citizen_legal_identity_hash_live_idx
// (FR-001: no second pending/active identity for the same legal identity).
export class DuplicateIdentityError extends Error {
  constructor() {
    super("A pending or active civic identity already exists for this legal identity.");
    this.name = "DuplicateIdentityError";
  }
}
