import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import { noopNotificationEmitter, type NotificationEvent } from "../notifications.js";
import { recordParticipationScores, sweepInactivity } from "./participation.js";

describe("recordParticipationScores", () => {
  it("scores a citizen as the equal-weighted (1 point each) sum of voting, review, and audit counts", () => {
    const store = createStore();
    const [record] = recordParticipationScores(store, "2026-06", [
      { citizenId: "c1", votingCount: 2, reviewCount: 1, auditCount: 3, quotaTarget: 4 },
    ]);
    expect(record!.score).toBe(6);
    expect(record!.period).toBe("2026-06");
    expect(record!.quotaTarget).toBe(4);
    expect(record!.inactivityStage).toBe(0);
    expect(record!.exemptionStatus).toBe("none");
  });

  // ARCH-018 EC-21: all-zero inputs compute to a score of exactly 0, a
  // valid non-error state distinct from "no record yet at all".
  it("ARCH-018 EC-21: scores a citizen with zero voting/review/audit counts as exactly 0, not an error", () => {
    const store = createStore();
    const [record] = recordParticipationScores(store, "2026-06", [
      { citizenId: "c1", votingCount: 0, reviewCount: 0, auditCount: 0, quotaTarget: 4 },
    ]);
    expect(record!.score).toBe(0);
  });

  it("updates the existing record for the same citizen and period rather than duplicating it", () => {
    const store = createStore();
    recordParticipationScores(store, "2026-06", [
      { citizenId: "c1", votingCount: 1, reviewCount: 0, auditCount: 0, quotaTarget: 4 },
    ]);
    recordParticipationScores(store, "2026-06", [
      { citizenId: "c1", votingCount: 5, reviewCount: 0, auditCount: 0, quotaTarget: 4 },
    ]);
    expect(store.listParticipationRecordsByPeriod("2026-06")).toHaveLength(1);
    expect(store.getParticipationRecord("c1", "2026-06")!.score).toBe(5);
  });

  it("preserves inactivityStage and exemptionStatus already on record when re-scoring the same period", () => {
    const store = createStore();
    recordParticipationScores(store, "2026-06", [
      { citizenId: "c1", votingCount: 0, reviewCount: 0, auditCount: 0, quotaTarget: 4 },
    ]);
    sweepInactivity(store, noopNotificationEmitter, "2026-06", 1);
    expect(store.getParticipationRecord("c1", "2026-06")!.inactivityStage).toBe(1);

    recordParticipationScores(store, "2026-06", [
      { citizenId: "c1", votingCount: 0, reviewCount: 0, auditCount: 0, quotaTarget: 4 },
    ]);
    expect(store.getParticipationRecord("c1", "2026-06")!.inactivityStage).toBe(1);
  });
});

describe("sweepInactivity", () => {
  function seedRecord(
    store: ReturnType<typeof createStore>,
    citizenId: string,
    period: string,
    score: number,
    inactivityStage: 0 | 1 | 2 | 3 = 0,
  ) {
    store.upsertParticipationRecord({
      citizenId,
      period,
      score,
      quotaTarget: 4,
      exemptionStatus: "none",
      inactivityStage,
    });
  }

  it("steps inactivityStage exactly one stage at a time per sweep for a citizen below threshold", () => {
    const store = createStore();
    seedRecord(store, "c1", "2026-06", 0, 0);

    sweepInactivity(store, noopNotificationEmitter, "2026-06", 5);
    expect(store.getParticipationRecord("c1", "2026-06")!.inactivityStage).toBe(1);

    sweepInactivity(store, noopNotificationEmitter, "2026-06", 5);
    expect(store.getParticipationRecord("c1", "2026-06")!.inactivityStage).toBe(2);

    sweepInactivity(store, noopNotificationEmitter, "2026-06", 5);
    expect(store.getParticipationRecord("c1", "2026-06")!.inactivityStage).toBe(3);
  });

  it("never advances a citizen past stage 3", () => {
    const store = createStore();
    seedRecord(store, "c1", "2026-06", 0, 3);
    sweepInactivity(store, noopNotificationEmitter, "2026-06", 5);
    expect(store.getParticipationRecord("c1", "2026-06")!.inactivityStage).toBe(3);
  });

  it("leaves a citizen at or above threshold with inactivityStage 0 unchanged", () => {
    const store = createStore();
    seedRecord(store, "c1", "2026-06", 10, 0);
    sweepInactivity(store, noopNotificationEmitter, "2026-06", 5);
    expect(store.getParticipationRecord("c1", "2026-06")!.inactivityStage).toBe(0);
  });

  it("resets inactivityStage straight to 0 once score recovers to or above threshold, regardless of prior stage", () => {
    const store = createStore();
    seedRecord(store, "c1", "2026-06", 10, 2);
    sweepInactivity(store, noopNotificationEmitter, "2026-06", 5);
    expect(store.getParticipationRecord("c1", "2026-06")!.inactivityStage).toBe(0);
  });

  it("dispatches a notification only on the transition into stage 1", () => {
    const store = createStore();
    seedRecord(store, "c1", "2026-06", 0, 0);
    const events: NotificationEvent[] = [];
    const emitter = { notify: (e: NotificationEvent) => events.push(e) };

    sweepInactivity(store, emitter, "2026-06", 5);
    expect(events).toEqual([{ citizenId: "c1", kind: "inactivity_reminder", period: "2026-06" }]);
  });

  it("dispatches a notification only on the transition into stage 2, not again on stage 3", () => {
    const store = createStore();
    seedRecord(store, "c1", "2026-06", 0, 1);
    const events: NotificationEvent[] = [];
    const emitter = { notify: (e: NotificationEvent) => events.push(e) };

    sweepInactivity(store, emitter, "2026-06", 5);
    expect(events).toEqual([{ citizenId: "c1", kind: "inactivity_reduced", period: "2026-06" }]);

    sweepInactivity(store, emitter, "2026-06", 5);
    expect(events).toHaveLength(1);
  });

  it("does not dispatch a notification on repeated sweeps that don't change the stage", () => {
    const store = createStore();
    seedRecord(store, "c1", "2026-06", 10, 0);
    const events: NotificationEvent[] = [];
    const emitter = { notify: (e: NotificationEvent) => events.push(e) };

    sweepInactivity(store, emitter, "2026-06", 5);
    sweepInactivity(store, emitter, "2026-06", 5);
    expect(events).toHaveLength(0);
  });
});
