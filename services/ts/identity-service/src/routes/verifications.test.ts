import { describe, expect, it } from "vitest";
import { buildTestServer } from "../test-utils.js";

async function registerCitizen(app: ReturnType<typeof buildTestServer>["app"], legalIdentifier: string) {
  const res = await app.inject({ method: "POST", url: "/citizens", payload: { legalIdentifier } });
  return res.json() as { id: string };
}

describe("POST /verifications (DP-002)", () => {
  it("activates the citizen on approved verification and emits audit.append", async () => {
    const { app, events } = buildTestServer({ verifyEvidence: async () => ({ approved: true }) });
    const citizen = await registerCitizen(app, "verify-approved");

    const res = await app.inject({
      method: "POST",
      url: "/verifications",
      payload: { citizenId: citizen.id, method: "passport", evidenceRef: "scan-ref-1" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("verified");
    expect(body.citizenStatus).toBe("active");

    const activated = await app.inject({ method: "GET", url: `/citizens/${citizen.id}` });
    expect(activated.json().status).toBe("active");

    expect(events.events.some((e) => e.topic === "audit.append")).toBe(true);
    await app.close();
  });

  it("leaves the citizen pending on rejected verification", async () => {
    const { app } = buildTestServer({ verifyEvidence: async () => ({ approved: false }) });
    const citizen = await registerCitizen(app, "verify-rejected");

    const res = await app.inject({
      method: "POST",
      url: "/verifications",
      payload: { citizenId: citizen.id, method: "national_id", evidenceRef: "bad-ref" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("rejected");
    expect(res.json().citizenStatus).toBe("pending");
    await app.close();
  });

  it("404s for an unknown citizen", async () => {
    const { app } = buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/verifications",
      payload: {
        citizenId: "00000000-0000-0000-0000-000000000000",
        method: "passport",
        evidenceRef: "x",
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("409s when the citizen is already active", async () => {
    const { app } = buildTestServer({ verifyEvidence: async () => ({ approved: true }) });
    const citizen = await registerCitizen(app, "verify-twice");
    await app.inject({
      method: "POST",
      url: "/verifications",
      payload: { citizenId: citizen.id, method: "passport", evidenceRef: "ref" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/verifications",
      payload: { citizenId: citizen.id, method: "passport", evidenceRef: "ref-2" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_pending");
    await app.close();
  });
});
