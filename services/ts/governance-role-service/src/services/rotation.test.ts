import { describe, expect, it, vi } from "vitest";
import { createStore } from "../store.js";
import { defaultAuditEmitter } from "../collaborators.js";
import type { NotificationEmitter, ReplacementRequester } from "../collaborators.js";
import { createRole } from "./roles.js";
import { sweepRotation } from "./rotation.js";

const NOW = new Date("2026-03-01T00:00:00Z");

describe("sweepRotation", () => {
  it("flags roles whose term ends within 7 days and notifies/requests a replacement once", () => {
    const store = createStore();
    const soon = createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-1",
      roleType: "auditor",
      layer: "audit",
      randomized: false,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-03-05T00:00:00Z"),
    });
    createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-2",
      roleType: "auditor",
      layer: "audit",
      randomized: false,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-12-01T00:00:00Z"),
    });

    const notify: NotificationEmitter = { notify: vi.fn() };
    const requestReplacement: ReplacementRequester = { requestReplacement: vi.fn() };

    const result = sweepRotation(store, notify, requestReplacement, defaultAuditEmitter, NOW);

    expect(result.flagged.map((r) => r.id)).toEqual([soon.id]);
    expect(result.flagged[0]?.offboardingNotified).toBe(true);
    expect(notify.notify).toHaveBeenCalledTimes(1);
    expect(requestReplacement.requestReplacement).toHaveBeenCalledTimes(1);
    expect(requestReplacement.requestReplacement).toHaveBeenCalledWith(soon.id);
  });

  it("does not re-flag or re-notify an already-flagged role on a later sweep", () => {
    const store = createStore();
    createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-1",
      roleType: "auditor",
      layer: "audit",
      randomized: false,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-03-05T00:00:00Z"),
    });

    const notify: NotificationEmitter = { notify: vi.fn() };
    const requestReplacement: ReplacementRequester = { requestReplacement: vi.fn() };

    sweepRotation(store, notify, requestReplacement, defaultAuditEmitter, NOW);
    const second = sweepRotation(store, notify, requestReplacement, defaultAuditEmitter, NOW);

    expect(second.flagged).toEqual([]);
    expect(notify.notify).toHaveBeenCalledTimes(1);
    expect(requestReplacement.requestReplacement).toHaveBeenCalledTimes(1);
  });

  it("does not flag a role whose term ends more than 7 days out", () => {
    const store = createStore();
    createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-1",
      roleType: "auditor",
      layer: "audit",
      randomized: false,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-12-01T00:00:00Z"),
    });

    const result = sweepRotation(
      store,
      { notify: vi.fn() },
      { requestReplacement: vi.fn() },
      defaultAuditEmitter,
      NOW,
    );

    expect(result.flagged).toEqual([]);
  });
});
