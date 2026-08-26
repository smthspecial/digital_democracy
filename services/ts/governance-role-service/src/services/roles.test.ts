import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import { defaultAuditEmitter } from "../collaborators.js";
import { createRole, listRoles } from "./roles.js";

describe("createRole", () => {
  it("creates a role with a generated id and stores it", () => {
    const store = createStore();
    const role = createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-1",
      roleType: "auditor",
      layer: "audit",
      randomized: true,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-06-01T00:00:00Z"),
    });

    expect(role.id).toBeTruthy();
    expect(role.citizenId).toBe("citizen-1");
    expect(role.offboardingNotified).toBe(false);
    expect(listRoles(store, {})).toEqual([role]);
  });

  it("rejects when term_end is not after term_start", () => {
    const store = createStore();
    expect(() =>
      createRole(store, defaultAuditEmitter, {
        citizenId: "citizen-1",
        roleType: "auditor",
        layer: "audit",
        randomized: false,
        termStart: new Date("2026-06-01T00:00:00Z"),
        termEnd: new Date("2026-06-01T00:00:00Z"),
      }),
    ).toThrow(/term_end/);
  });
});

describe("listRoles", () => {
  it("filters by citizenId and roleType", () => {
    const store = createStore();
    const a = createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-1",
      roleType: "auditor",
      layer: "audit",
      randomized: false,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-06-01T00:00:00Z"),
    });
    createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-2",
      roleType: "reviewer",
      layer: "citizen",
      randomized: false,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-06-01T00:00:00Z"),
    });

    expect(listRoles(store, { citizenId: "citizen-1" })).toEqual([a]);
    expect(listRoles(store, { roleType: "reviewer" })).toHaveLength(1);
  });
});
