import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHttpAuditEmitter,
  createHttpConstitutionalReviewer,
} from "./integrations.js";

// These exercise the real HTTP seam implementations against a minimal
// stand-in for audit-service's actual wire contract (SRV-012's
// POST /audit/log and POST /audit/proposals/:id/constitutional-review) --
// the first integration-level tests in this codebase per ARCH-009. They
// are not unit tests of a mocked interface: they assert on the real
// request method/path/body sent over the wire and the real response shape
// parsed back.

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    body: string,
  ) => void,
): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a network address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("createHttpAuditEmitter (integration)", () => {
  it("POSTs to /audit/log with the mapped action_type and actor_ref", async () => {
    let received: { method?: string; url?: string; body?: unknown } = {};
    const baseUrl = await listen((req, res, body) => {
      received = { method: req.method, url: req.url, body: JSON.parse(body) };
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "audit-1" }));
    });

    const emitter = createHttpAuditEmitter(baseUrl);
    emitter.emit("proposal.status_changed", { proposalId: "p1", from: "draft", to: "gathering_support" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received.method).toBe("POST");
    expect(received.url).toBe("/audit/log");
    expect(received.body).toMatchObject({
      action_type: "proposal_status_changed",
      actor_ref: "proposal-service",
      payload: { proposalId: "p1", from: "draft", to: "gathering_support" },
    });
    expect((received.body as { idempotency_key: string }).idempotency_key).toBeTypeOf("string");
  });

  it("maps proposal.created and proposal.deadlock_entered to their audit-service action types", async () => {
    const seen: string[] = [];
    const baseUrl = await listen((req, res, body) => {
      seen.push((JSON.parse(body) as { action_type: string }).action_type);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "audit-1" }));
    });

    const emitter = createHttpAuditEmitter(baseUrl);
    emitter.emit("proposal.created", { proposalId: "p1" });
    emitter.emit("proposal.deadlock_entered", { proposalId: "p1" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toEqual(["proposal_created", "proposal_status_changed"]);
  });

  it("swallows a failed emission without throwing (fire-and-forget)", async () => {
    const emitter = createHttpAuditEmitter("http://127.0.0.1:1");
    expect(() => emitter.emit("proposal.created", { proposalId: "p1" })).not.toThrow();
  });
});

describe("createHttpConstitutionalReviewer (integration)", () => {
  it("POSTs the change summary and returns blocked=false when cleared", async () => {
    let received: { url?: string; body?: unknown } = {};
    const baseUrl = await listen((req, res, body) => {
      received = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ blocked: false, reviews: [] }));
    });

    const reviewer = createHttpConstitutionalReviewer(baseUrl);
    const result = await reviewer.review("proposal-1", "Repave Main Street");

    expect(received.url).toBe("/audit/proposals/proposal-1/constitutional-review");
    expect(received.body).toEqual({ change_summary: "Repave Main Street" });
    expect(result).toEqual({ blocked: false });
  });

  it("returns blocked=true when audit-service blocks the proposal", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ blocked: true, reviews: [{ result: "blocked" }] }));
    });

    const reviewer = createHttpConstitutionalReviewer(baseUrl);
    const result = await reviewer.review("proposal-1", "Restrict free speech online");

    expect(result).toEqual({ blocked: true });
  });

  it("fails closed (rejects) when audit-service is unreachable", async () => {
    const reviewer = createHttpConstitutionalReviewer("http://127.0.0.1:1");
    await expect(reviewer.review("proposal-1", "x")).rejects.toThrow();
  });

  it("fails closed (rejects) on a non-2xx response", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    });

    const reviewer = createHttpConstitutionalReviewer(baseUrl);
    await expect(reviewer.review("proposal-1", "x")).rejects.toThrow(/status 500/);
  });
});
