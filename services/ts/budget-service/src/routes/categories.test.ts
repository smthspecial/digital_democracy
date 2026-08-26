import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";

describe("budget categories routes", () => {
  const store = createStore();
  const app = buildServer({ store });

  afterAll(async () => {
    await app.close();
  });

  it("POST /budget/categories creates a root category", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: {
        jurisdiction_id: "jur-1",
        parent_id: null,
        name: "Healthcare",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      jurisdictionId: "jur-1",
      parentId: null,
      name: "Healthcare",
      allocatedAmount: 0,
    });
    expect(typeof body.id).toBe("string");
  });

  it("POST /budget/categories creates a child category", async () => {
    const parentRes = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-2", parent_id: null, name: "Root" },
    });
    const parent = parentRes.json();

    const childRes = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: {
        jurisdiction_id: "jur-2",
        parent_id: parent.id,
        name: "Child",
      },
    });

    expect(childRes.statusCode).toBe(201);
    expect(childRes.json()).toMatchObject({
      jurisdictionId: "jur-2",
      parentId: parent.id,
      name: "Child",
    });
  });

  it("POST /budget/categories allows an omitted parent_id (defaults to root)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: "jur-3", name: "No explicit parent" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().parentId).toBeNull();
  });

  it.each([
    [{ parent_id: null, name: "Missing jurisdiction" }],
    [{ jurisdiction_id: "jur-3", parent_id: null }],
  ])("POST /budget/categories rejects incomplete body %#", async (payload) => {
    const res = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /budget/categories/:jurisdictionId/tree returns hierarchy", async () => {
    const jurisdictionId = "jur-tree";
    const rootRes = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: { jurisdiction_id: jurisdictionId, parent_id: null, name: "Root" },
    });
    const root = rootRes.json();

    const childRes = await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: {
        jurisdiction_id: jurisdictionId,
        parent_id: root.id,
        name: "Child",
      },
    });
    const child = childRes.json();

    await app.inject({
      method: "POST",
      url: "/budget/categories",
      payload: {
        jurisdiction_id: jurisdictionId,
        parent_id: child.id,
        name: "Grandchild",
      },
    });

    const treeRes = await app.inject({
      method: "GET",
      url: `/budget/categories/${jurisdictionId}/tree`,
    });

    expect(treeRes.statusCode).toBe(200);
    const tree = treeRes.json();
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(root.id);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe(child.id);
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].name).toBe("Grandchild");
  });

  it("GET /budget/categories/:jurisdictionId/tree returns empty array for unknown jurisdiction", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/budget/categories/nonexistent/tree",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
