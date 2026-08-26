import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";

describe("governance roles routes", () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  it("POST /governance-roles/roles creates a role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/governance-roles/roles",
      payload: {
        citizen_id: "citizen-1",
        role_type: "auditor",
        layer: "audit",
        randomized: true,
        term_start: "2026-01-01T00:00:00.000Z",
        term_end: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.citizen_id).toBe("citizen-1");
    expect(body.randomized).toBe(true);
    expect(body.offboarding_notified).toBe(false);
  });

  it("POST /governance-roles/roles rejects term_end <= term_start with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/governance-roles/roles",
      payload: {
        citizen_id: "citizen-1",
        role_type: "auditor",
        layer: "audit",
        randomized: false,
        term_start: "2026-06-01T00:00:00.000Z",
        term_end: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("POST /governance-roles/roles rejects a malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/governance-roles/roles",
      payload: {
        citizen_id: "citizen-1",
        role_type: "not-a-real-type",
        layer: "audit",
        randomized: false,
        term_start: "2026-01-01T00:00:00.000Z",
        term_end: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("GET /governance-roles/roles lists roles and supports filters", async () => {
    await app.inject({
      method: "POST",
      url: "/governance-roles/roles",
      payload: {
        citizen_id: "citizen-2",
        role_type: "reviewer",
        layer: "citizen",
        randomized: false,
        term_start: "2026-01-01T00:00:00.000Z",
        term_end: "2026-06-01T00:00:00.000Z",
      },
    });

    const all = await app.inject({ method: "GET", url: "/governance-roles/roles" });
    expect(all.statusCode).toBe(200);
    expect(all.json().length).toBeGreaterThanOrEqual(2);

    const filtered = await app.inject({
      method: "GET",
      url: "/governance-roles/roles?citizen_id=citizen-2",
    });
    expect(filtered.statusCode).toBe(200);
    const roles = filtered.json();
    expect(roles).toHaveLength(1);
    expect(roles[0].citizen_id).toBe("citizen-2");
  });
});
