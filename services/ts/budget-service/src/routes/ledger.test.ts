import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";

describe("budget ledger routes", () => {
  const store = createStore();
  const app = buildServer({ store });

  let categoryId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-1", parent_id: null, name: "Roads" },
    });
    categoryId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /budget/ledger appends an inflow entry", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: null,
        type: "inflow",
        amount: 5000,
        description: "Annual tax revenue",
        recorded_by: "operator-1",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      categoryId: null,
      type: "inflow",
      amount: 5000,
    });
  });

  it("POST /budget/ledger accepts and stores a project_id, filterable via GET (TBL-028)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: null,
        project_id: "project-1",
        type: "outflow",
        amount: 300,
        description: "Contractor payment",
        recorded_by: "operator-1",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ projectId: "project-1" });

    const listRes = await app.inject({ method: "GET", url: "/budget/ledger?project_id=project-1" });
    expect(listRes.json()).toHaveLength(1);
    expect(listRes.json()[0].projectId).toBe("project-1");
  });

  it("POST /budget/ledger rejects a category_id that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: "does-not-exist",
        type: "outflow",
        amount: 100,
        description: "Pothole repair",
        recorded_by: "operator-1",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /budget/ledger lists all entries and supports category_id filter", async () => {
    await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: categoryId,
        type: "outflow",
        amount: 200,
        description: "Pothole repair",
        recorded_by: "operator-1",
      },
    });

    const allRes = await app.inject({ method: "GET", url: "/budget/ledger" });
    expect(allRes.statusCode).toBe(200);
    expect(allRes.json().length).toBeGreaterThanOrEqual(2);

    const filteredRes = await app.inject({
      method: "GET",
      url: `/budget/ledger?category_id=${categoryId}`,
    });
    const filtered = filteredRes.json();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].categoryId).toBe(categoryId);
  });

  it.each(["PUT", "DELETE"] as const)(
    "%s /budget/ledger/:id is not a registered route",
    async (method) => {
      const res = await app.inject({
        method,
        url: "/budget/ledger/some-id",
      });
      expect([404, 405]).toContain(res.statusCode);
    },
  );

  // ABUSE-FIN-2 (testing/e2e-api-test-plan.md): the request schema types
  // `amount` as a bare number with no minimum/sign constraint, and nothing
  // in the service layer derives or checks a sign from `type` either -- a
  // negative amount is accepted for both inflow and outflow, corrupting the
  // public ledger and any reconciliation built on top of it (a negative
  // outflow nets as money appearing rather than leaving, and vice versa).
  // recorded_by is also never verified as belonging to an authorized
  // operator (srv-007.md's stated intent), so this is fully reachable by
  // any caller. These two prove the gap directly rather than by assumption.
  it("ABUSE-FIN-2: accepts a negative amount on an outflow (nets as money appearing, not leaving)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: null,
        type: "outflow",
        amount: -50000,
        description: "fabricated negative outflow",
        recorded_by: "anyone-claiming-to-be-an-operator",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe(-50000);
  });

  it("ABUSE-FIN-2: accepts a negative amount on an inflow (nets as money leaving, not appearing)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: null,
        type: "inflow",
        amount: -1,
        description: "fabricated negative inflow",
        recorded_by: "anyone-claiming-to-be-an-operator",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe(-1);
  });
});
