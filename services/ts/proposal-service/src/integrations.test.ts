import { createServer, type Server } from "node:http";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { connectEventBus, consume, ensureStream, type EventBus } from "@dd/event-bus";
import {
  AUDIT_APPEND_STREAM,
  AUDIT_APPEND_SUBJECT,
  createHttpAuditEmitter,
  createHttpConstitutionalReviewer,
  createHttpJurisdictionClient,
  createHttpProblemStatusNotifier,
  createNatsAuditEmitter,
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

// Exercises createHttpJurisdictionClient against a minimal stand-in for
// jurisdiction-service's real wire contract (SRV-002's
// GET /jurisdiction/jurisdictions/:id/tree). ARCH-011 EC-5, EC-30.
describe("createHttpJurisdictionClient (integration)", () => {
  it("IT-011-EC-5: returns true when jurisdiction-service resolves the id (200)", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "jurisdiction-1", children: [] }));
    });

    const client = createHttpJurisdictionClient(baseUrl);
    const result = await client.exists("jurisdiction-1");

    expect(receivedUrl).toBe("/jurisdiction/jurisdictions/jurisdiction-1/tree");
    expect(result).toBe(true);
  });

  it("IT-011-EC-5: returns false when jurisdiction-service 404s (unknown id)", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "jurisdiction not found" }));
    });

    const client = createHttpJurisdictionClient(baseUrl);
    await expect(client.exists("no-such-jurisdiction")).resolves.toBe(false);
  });

  it("IT-011-EC-30: fails closed (false) when jurisdiction-service is unreachable", async () => {
    const client = createHttpJurisdictionClient("http://127.0.0.1:1");
    await expect(client.exists("jurisdiction-1")).resolves.toBe(false);
  });

  it("URL-encodes the jurisdiction id", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });

    const client = createHttpJurisdictionClient(baseUrl);
    await client.exists("id with spaces");

    expect(receivedUrl).toBe("/jurisdiction/jurisdictions/id%20with%20spaces/tree");
  });
});

// Exercises createHttpProblemStatusNotifier against a minimal stand-in for
// problem-service's real wire contract (SRV-003's
// POST /problems/:id/status). ARCH-012 EC-33.
describe("createHttpProblemStatusNotifier (integration)", () => {
  it("IT-012-EC-33: POSTs the target status to /problems/:id/status", async () => {
    let received: { method?: string; url?: string; body?: unknown } = {};
    const baseUrl = await listen((req, res, body) => {
      received = { method: req.method, url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "problem-1", status: "proposing" }));
    });

    const notifier = createHttpProblemStatusNotifier(baseUrl);
    notifier.notify("problem-1", "proposing");

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received.method).toBe("POST");
    expect(received.url).toBe("/problems/problem-1/status");
    expect(received.body).toEqual({ status: "proposing" });
  });

  it("URL-encodes the problem id", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });

    const notifier = createHttpProblemStatusNotifier(baseUrl);
    notifier.notify("problem with spaces", "closed");

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(receivedUrl).toBe("/problems/problem%20with%20spaces/status");
  });

  it("swallows a failed call without throwing (fire-and-forget)", () => {
    const notifier = createHttpProblemStatusNotifier("http://127.0.0.1:1");
    expect(() => notifier.notify("problem-1", "closed")).not.toThrow();
  });
});

// Exercises createNatsAuditEmitter against a real spawned nats-server
// (ARCH-009 §2's "boot the real thing" convention, applied to a message
// broker for the first time -- ADR-023). Requires nats-server on PATH
// (go install github.com/nats-io/nats-server/v2@latest).
describe("createNatsAuditEmitter (integration, against a real nats-server)", () => {
  let natsProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let bus: EventBus | undefined;

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createNetServer();
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        if (address === null || typeof address === "string") {
          reject(new Error("expected a network address"));
          return;
        }
        const { port } = address;
        srv.close(() => resolve(port));
      });
    });
  }

  async function startNatsServer(): Promise<string> {
    const port = await freePort();
    const storeDir = await mkdtemp(path.join(tmpdir(), "dd-integrations-nats-"));
    natsProcess = spawn("nats-server", ["-p", String(port), "-js", "-sd", storeDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const conn = createConnection({ port, host: "127.0.0.1" });
        conn.once("connect", () => {
          conn.destroy();
          resolve(true);
        });
        conn.once("error", () => resolve(false));
      });
      if (ok) return `nats://127.0.0.1:${port}`;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("nats-server did not start listening in time");
  }

  afterEach(async () => {
    if (bus) {
      await bus.close();
      bus = undefined;
    }
    if (natsProcess) {
      natsProcess.kill("SIGTERM");
      natsProcess = undefined;
    }
  });

  it("IT-eventbus: publishes the mapped action_type and actor_ref to the real audit.append stream", async () => {
    const url = await startNatsServer();
    bus = await connectEventBus(url);
    await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });

    const emitter = createNatsAuditEmitter(bus);
    emitter.emit("proposal.status_changed", { proposalId: "p1", from: "draft", to: "gathering_support" });

    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      void consume(bus!, { stream: AUDIT_APPEND_STREAM, durable: "test-consumer" }, (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(new TextDecoder().decode(data)));
      });
    });

    expect(received).toMatchObject({
      action_type: "proposal_status_changed",
      actor_ref: "proposal-service",
      payload: { proposalId: "p1", from: "draft", to: "gathering_support" },
    });
    expect(received.idempotency_key).toBeTypeOf("string");
  });

  it("IT-eventbus: maps proposal.created and proposal.deadlock_entered to their audit-service action types", async () => {
    const url = await startNatsServer();
    bus = await connectEventBus(url);
    await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });

    const emitter = createNatsAuditEmitter(bus);
    emitter.emit("proposal.created", { proposalId: "p1" });
    emitter.emit("proposal.deadlock_entered", { proposalId: "p1" });

    const seen: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for messages")), 3000);
      void consume(bus!, { stream: AUDIT_APPEND_STREAM, durable: "test-consumer-2" }, (data) => {
        const body = JSON.parse(new TextDecoder().decode(data)) as { action_type: string };
        seen.push(body.action_type);
        if (seen.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    expect(seen).toEqual(["proposal_created", "proposal_status_changed"]);
  });
});
