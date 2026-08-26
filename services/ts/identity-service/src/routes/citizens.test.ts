import { afterAll, describe, expect, it } from "vitest";
import { buildTestServer } from "../test-utils.js";

describe("POST /citizens (DP-001)", () => {
  const { app } = buildTestServer();
  afterAll(() => app.close());

  it("registers a new citizen as pending", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/citizens",
      payload: { legalIdentifier: "national-id-123" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("pending");
    expect(body.publicHandle).toMatch(/^cit-/);
    expect(body).not.toHaveProperty("legalIdentityHash");
  });

  it("rejects a second registration for the same legal identifier (FR-001)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/citizens",
      payload: { legalIdentifier: "national-id-dupe" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/citizens",
      payload: { legalIdentifier: "national-id-dupe" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("duplicate_identity");
  });

  it("rejects a missing legalIdentifier", async () => {
    const res = await app.inject({ method: "POST", url: "/citizens", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("GET /citizens/:id returns the public record", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/citizens",
      payload: { legalIdentifier: "national-id-456" },
    });
    const { id } = created.json();

    const res = await app.inject({ method: "GET", url: `/citizens/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it("GET /citizens/:id returns 404 for an unknown id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/citizens/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});
