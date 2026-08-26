import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { NotificationEmitter } from "../integrations.js";

async function createDomain(app: ReturnType<typeof buildServer>) {
  const res = await app.inject({
    method: "POST",
    url: "/competency/domains",
    payload: { name: "transportation", description: "desc" },
  });
  return res.json().id as string;
}

async function grantActiveCompetency(app: ReturnType<typeof buildServer>, domainId: string, citizenId: string) {
  const appRes = await app.inject({
    method: "POST",
    url: "/competency/applications",
    payload: { citizen_id: citizenId, domain_id: domainId },
  });
  const competencyId = appRes.json().id as string;
  for (let i = 0; i < 4; i++) {
    await app.inject({ method: "POST", url: `/competency/applications/${competencyId}/advance` });
  }
  return competencyId;
}

describe("expiry sweep route", () => {
  it("expires only active + past-expiry competencies, notifies holders, and is idempotent on immediate re-run", async () => {
    const store = createStore();
    const notificationEmitter: NotificationEmitter = { notifyExpired: vi.fn() };
    const app = buildServer({ store, notificationEmitter });

    const domainId = await createDomain(app);
    const pastDueId = await grantActiveCompetency(app, domainId, "citizen-expired");
    const stillValidId = await grantActiveCompetency(app, domainId, "citizen-current");

    const pastDue = store.competencies.get(pastDueId);
    if (!pastDue) throw new Error("expected competency to exist");
    pastDue.expiresAt = new Date(Date.now() - 1000);

    const res = await app.inject({ method: "POST", url: "/competency/expiry-sweep" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ expired_count: 1 });

    expect(store.competencies.get(pastDueId)?.status).toBe("expired");
    expect(store.competencies.get(stillValidId)?.status).toBe("active");
    expect(notificationEmitter.notifyExpired).toHaveBeenCalledWith("citizen-expired", pastDueId);
    expect(notificationEmitter.notifyExpired).toHaveBeenCalledTimes(1);

    const secondRes = await app.inject({ method: "POST", url: "/competency/expiry-sweep" });
    expect(secondRes.json()).toEqual({ expired_count: 0 });
    expect(notificationEmitter.notifyExpired).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
