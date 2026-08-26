import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";

describe("budget allocations routes", () => {
  const store = createStore();
  const app = buildServer({ store });

  let healthcareId: string;
  let educationId: string;

  beforeAll(async () => {
    const healthcare = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-1", parent_id: null, name: "Healthcare" },
    });
    healthcareId = healthcare.json().id;

    const education = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-1", parent_id: null, name: "Education" },
    });
    educationId = education.json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /budget/allocations rejects a set that does not sum to 100 and reports the actual sum", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "citizen-1",
        period: "2026-Q1",
        allocations: [
          { category_id: healthcareId, percentage: 40 },
          { category_id: educationId, percentage: 40 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/80/);
  });

  it("POST /budget/allocations rejects a nonexistent category_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "citizen-1",
        period: "2026-Q1",
        allocations: [{ category_id: "does-not-exist", percentage: 100 }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /budget/allocations accepts a set summing to exactly 100", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "citizen-1",
        period: "2026-Q1",
        allocations: [
          { category_id: healthcareId, percentage: 60 },
          { category_id: educationId, percentage: 40 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveLength(2);
  });

  it("resubmitting for the same citizen+period replaces rather than adds", async () => {
    await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "citizen-2",
        period: "2026-Q1",
        allocations: [{ category_id: healthcareId, percentage: 100 }],
      },
    });

    const secondRes = await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "citizen-2",
        period: "2026-Q1",
        allocations: [
          { category_id: healthcareId, percentage: 30 },
          { category_id: educationId, percentage: 70 },
        ],
      },
    });
    expect(secondRes.statusCode).toBe(201);

    const aggregateRes = await app.inject({
      method: "POST",
      url: "/budget/allocations/aggregate",
      payload: { period: "2026-Q1", total_pool: 1000 },
    });
    const results = aggregateRes.json() as Array<{
      categoryId: string;
      voteCount: number;
    }>;
    const healthcareResult = results.find((r) => r.categoryId === healthcareId);
    // citizen-2's original 100% healthcare vote must be gone, leaving only
    // citizen-1 (60%) and citizen-2's replacement (30%) -> 2 votes, not 3.
    expect(healthcareResult?.voteCount).toBe(2);
  });

  it("aggregation computes the weighted average percentage across citizens", async () => {
    const jur = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-agg", parent_id: null, name: "Parks" },
    });
    const parksId = jur.json().id;
    const other = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-agg", parent_id: null, name: "Other" },
    });
    const otherId = other.json().id;

    await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "agg-citizen-1",
        period: "2026-Q2",
        allocations: [
          { category_id: parksId, percentage: 20 },
          { category_id: otherId, percentage: 80 },
        ],
      },
    });
    await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "agg-citizen-2",
        period: "2026-Q2",
        allocations: [
          { category_id: parksId, percentage: 60 },
          { category_id: otherId, percentage: 40 },
        ],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/budget/allocations/aggregate",
      payload: { period: "2026-Q2", total_pool: 10000 },
    });
    expect(res.statusCode).toBe(200);
    const [result] = res.json();
    expect(result.categoryId).toBe(parksId);
    expect(result.voteCount).toBe(2);
    expect(result.averagePercentage).toBe(40);
    expect(result.allocatedAmount).toBe(4000);

    const treeRes = await app.inject({
      method: "GET",
      url: "/budget/categories/jur-agg/tree",
    });
    expect(treeRes.json()[0].allocatedAmount).toBe(4000);
  });

  it("aggregation omits categories with no votes that period", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/allocations/aggregate",
      payload: { period: "2099-never-voted", total_pool: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
