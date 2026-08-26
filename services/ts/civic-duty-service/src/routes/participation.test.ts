import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { NotificationEvent } from "../notifications.js";

describe("POST /civic-duty/participation/score", () => {
  it("writes a participation_record with the equal-weighted score", async () => {
    const app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/participation/score",
      payload: {
        period: "2026-06",
        inputs: [
          { citizen_id: "c1", voting_count: 2, review_count: 1, audit_count: 0, quota_target: 4 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ citizenId: "c1", period: "2026-06", score: 3, quotaTarget: 4 });
    await app.close();
  });

  it("rejects a malformed body", async () => {
    const app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/participation/score",
      payload: { period: "2026-06" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /civic-duty/inactivity/sweep", () => {
  it("steps inactivityStage and dispatches a notification only on the stage-1 transition", async () => {
    const store = createStore();
    store.upsertParticipationRecord({
      citizenId: "c1",
      period: "2026-06",
      score: 0,
      quotaTarget: 4,
      exemptionStatus: "none",
      inactivityStage: 0,
    });
    const events: NotificationEvent[] = [];
    const app = buildServer({ store, notifier: { notify: (e) => events.push(e) } });

    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/inactivity/sweep",
      payload: { period: "2026-06", inactivity_threshold_score: 5 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ citizenId: "c1", inactivityStage: 1 });
    expect(events).toEqual([{ citizenId: "c1", kind: "inactivity_reminder", period: "2026-06" }]);
    await app.close();
  });

  it("does not notify again on a repeat sweep that doesn't change the stage", async () => {
    const store = createStore();
    store.upsertParticipationRecord({
      citizenId: "c1",
      period: "2026-06",
      score: 10,
      quotaTarget: 4,
      exemptionStatus: "none",
      inactivityStage: 0,
    });
    const events: NotificationEvent[] = [];
    const app = buildServer({ store, notifier: { notify: (e) => events.push(e) } });

    await app.inject({
      method: "POST",
      url: "/civic-duty/inactivity/sweep",
      payload: { period: "2026-06", inactivity_threshold_score: 5 },
    });
    await app.inject({
      method: "POST",
      url: "/civic-duty/inactivity/sweep",
      payload: { period: "2026-06", inactivity_threshold_score: 5 },
    });

    expect(events).toHaveLength(0);
    await app.close();
  });
});
