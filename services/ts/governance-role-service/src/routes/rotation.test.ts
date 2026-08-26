import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { Store } from "../store.js";

describe("governance rotation sweep route", () => {
  let store: Store;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = createStore();
    app = buildServer({ store });
  });

  afterAll(async () => {
    await app.close();
  });

  it("flags a role ending within 7 days and does not re-flag on a later sweep", async () => {
    await app.inject({
      method: "POST",
      url: "/governance-roles/roles",
      payload: {
        citizen_id: "citizen-1",
        role_type: "auditor",
        layer: "audit",
        randomized: false,
        term_start: "2026-01-01T00:00:00.000Z",
        term_end: "2026-03-05T00:00:00.000Z",
      },
    });

    const first = await app.inject({
      method: "POST",
      url: "/governance-roles/rotation/sweep",
      payload: { now: "2026-03-01T00:00:00.000Z" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().flagged_count).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: "/governance-roles/rotation/sweep",
      payload: { now: "2026-03-01T00:00:00.000Z" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().flagged_count).toBe(0);
  });

  it("defaults now server-side when omitted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/governance-roles/rotation/sweep",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flagged_count).toBe(0);
  });
});
