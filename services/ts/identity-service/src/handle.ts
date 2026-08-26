import { randomBytes } from "node:crypto";

// TBL-001.public_handle: a non-identifying public participation handle,
// assigned by the service rather than chosen by the citizen so it carries
// no link back to their legal identity.
export function generatePublicHandle(): string {
  return `cit-${randomBytes(6).toString("hex")}`;
}
