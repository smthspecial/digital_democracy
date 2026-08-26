import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { AlertEmitter } from "../services/reconciliation.js";

describe("budget reconcile route", () => {
  it("reports zero discrepancy and does not alert when spend matches allocation", async () => {
    const store = createStore();
    const alertEmitter: AlertEmitter = { emit: vi.fn() };
    const app = buildServer({ store, alertEmitter });

    const catRes = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-1", parent_id: null, name: "Roads" },
    });
    const categoryId = catRes.json().id;

    await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "citizen-1",
        period: "2026-Q1",
        allocations: [{ category_id: categoryId, percentage: 100 }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/budget/allocations/aggregate",
      payload: { period: "2026-Q1", total_pool: 1000 },
    });

    await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: categoryId,
        type: "outflow",
        amount: 1000,
        description: "Road repaving",
        recorded_by: "operator-1",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/budget/reconcile",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const [result] = res.json();
    expect(result).toMatchObject({ categoryId, allocated: 1000, spent: 1000, discrepancy: 0 });
    expect(alertEmitter.emit).not.toHaveBeenCalled();

    await app.close();
  });

  it("reports a non-zero discrepancy and alerts exactly once for it", async () => {
    const store = createStore();
    const alertEmitter: AlertEmitter = { emit: vi.fn() };
    const app = buildServer({ store, alertEmitter });

    const catRes = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-1", parent_id: null, name: "Parks" },
    });
    const categoryId = catRes.json().id;

    await app.inject({
      method: "POST",
      url: "/budget/allocations",
      payload: {
        citizen_id: "citizen-1",
        period: "2026-Q1",
        allocations: [{ category_id: categoryId, percentage: 100 }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/budget/allocations/aggregate",
      payload: { period: "2026-Q1", total_pool: 1000 },
    });

    await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: categoryId,
        type: "outflow",
        amount: 700,
        description: "Playground",
        recorded_by: "operator-1",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/budget/reconcile",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const [result] = res.json();
    expect(result).toMatchObject({ categoryId, allocated: 1000, spent: 700, discrepancy: 300 });
    expect(alertEmitter.emit).toHaveBeenCalledTimes(1);
    expect(alertEmitter.emit).toHaveBeenCalledWith(categoryId, 300);

    await app.close();
  });

  it("only alerts on categories with a non-zero discrepancy, not on zero ones", async () => {
    const store = createStore();
    const alertEmitter: AlertEmitter = { emit: vi.fn() };
    const app = buildServer({ store, alertEmitter });

    const zeroRes = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-1", parent_id: null, name: "Zero" },
    });
    const zeroId = zeroRes.json().id;

    const nonZeroRes = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-1", parent_id: null, name: "NonZero" },
    });
    const nonZeroId = nonZeroRes.json().id;

    await app.inject({
      method: "POST",
      url: "/budget/ledger",
      payload: {
        category_id: nonZeroId,
        type: "outflow",
        amount: 50,
        description: "spend",
        recorded_by: "operator-1",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/budget/reconcile",
      payload: {},
    });

    const results = res.json() as Array<{ categoryId: string; discrepancy: number }>;
    const zero = results.find((r) => r.categoryId === zeroId);
    const nonZero = results.find((r) => r.categoryId === nonZeroId);
    expect(zero?.discrepancy).toBe(0);
    expect(nonZero?.discrepancy).toBe(-50);
    expect(alertEmitter.emit).toHaveBeenCalledTimes(1);
    expect(alertEmitter.emit).toHaveBeenCalledWith(nonZeroId, -50);

    await app.close();
  });
});
