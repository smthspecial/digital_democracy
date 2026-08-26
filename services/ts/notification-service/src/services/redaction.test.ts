import { describe, expect, it } from "vitest";
import { findBannedKey } from "./redaction.js";

const BANNED_KEYS = [
  "ballot_choice",
  "legal_identity",
  "government_id",
  "legal_identity_hash",
  "raw_legal_identifier",
];

describe("findBannedKey", () => {
  it.each(BANNED_KEYS)("flags top-level banned key %s", (key) => {
    expect(findBannedKey({ [key]: "x" })).toBe(key);
  });

  it.each(BANNED_KEYS)("flags nested banned key %s", (key) => {
    expect(findBannedKey({ meta: { detail: { [key]: "x" } } })).toBe(key);
  });

  it.each(BANNED_KEYS)("flags banned key %s case-insensitively", (key) => {
    expect(findBannedKey({ [key.toUpperCase()]: "x" })).toBe(key.toUpperCase());
  });

  it("flags a banned key nested inside an array of objects", () => {
    expect(findBannedKey({ items: [{ ok: true }, { government_id: "1" }] })).toBe("government_id");
  });

  it("returns undefined for a payload with no banned keys", () => {
    expect(findBannedKey({ title: "Vote reminder", meta: { session_id: "abc" } })).toBeUndefined();
  });

  it("returns undefined for an empty payload", () => {
    expect(findBannedKey({})).toBeUndefined();
  });
});
