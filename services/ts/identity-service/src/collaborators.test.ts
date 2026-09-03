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
  createHttpApprovalGate,
  createHttpSessionRevoker,
  createNatsAuditEmitter,
} from "./collaborators.js";

// Exercises the real HTTP seam implementation against a minimal stand-in
// for auth-service's actual wire contract (SRV-017's
// POST /auth/internal/revoke-all/:citizenId) -- see proposal-service's
// integrations.test.ts for the sibling pattern this follows.

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function listen(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a network address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("createHttpSessionRevoker (integration)", () => {
  it("POSTs to /auth/internal/revoke-all/:citizenId", async () => {
    let received: { method?: string; url?: string } = {};
    const baseUrl = await listen((req, res) => {
      received = { method: req.method, url: req.url };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count: 2 }));
    });

    const revoker = createHttpSessionRevoker(baseUrl);
    revoker.revokeAllSessions("citizen-1");

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received.method).toBe("POST");
    expect(received.url).toBe("/auth/internal/revoke-all/citizen-1");
  });

  it("URL-encodes the citizen id", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count: 0 }));
    });

    const revoker = createHttpSessionRevoker(baseUrl);
    revoker.revokeAllSessions("citizen with spaces");

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(receivedUrl).toBe("/auth/internal/revoke-all/citizen%20with%20spaces");
  });

  it("swallows a failed call without throwing (fire-and-forget)", () => {
    const revoker = createHttpSessionRevoker("http://127.0.0.1:1");
    expect(() => revoker.revokeAllSessions("citizen-1")).not.toThrow();
  });
});

// Exercises createHttpApprovalGate against a minimal stand-in for
// governance-role-service's real wire contract (SRV-011's
// GET /governance-roles/actions/:actionRef/status), same pattern as
// createHttpSessionRevoker above. ARCH-010 EC-7, EC-16.
describe("createHttpApprovalGate (integration)", () => {
  it("IT-010-HP3/HP4: GETs the action-type-scoped action_ref and reads fully_approved", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fully_approved: true }));
    });

    const gate = createHttpApprovalGate(baseUrl);
    const result = await gate.hasRequiredApprovals("citizen-1", "suspend");

    expect(receivedUrl).toBe("/governance-roles/actions/identity%3Asuspend%3Acitizen-1/status");
    expect(result).toBe(true);
  });

  it("IT-010-EC-7: scopes the action_ref by actionType, so suspend and revoke are checked independently", async () => {
    const urls: string[] = [];
    const baseUrl = await listen((req, res) => {
      urls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fully_approved: req.url?.includes("suspend") }));
    });

    const gate = createHttpApprovalGate(baseUrl);
    const suspendResult = await gate.hasRequiredApprovals("citizen-1", "suspend");
    const revokeResult = await gate.hasRequiredApprovals("citizen-1", "revoke");

    expect(suspendResult).toBe(true);
    expect(revokeResult).toBe(false);
    expect(urls[0]).not.toBe(urls[1]);
  });

  it("IT-010-EC-16: fails closed (false) when governance-role-service returns a non-2xx status", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });

    const gate = createHttpApprovalGate(baseUrl);
    await expect(gate.hasRequiredApprovals("citizen-1", "suspend")).resolves.toBe(false);
  });

  it("IT-010-EC-16: fails closed (false) when governance-role-service is unreachable", async () => {
    const gate = createHttpApprovalGate("http://127.0.0.1:1");
    await expect(gate.hasRequiredApprovals("citizen-1", "suspend")).resolves.toBe(false);
  });

  it("fails closed (false) when fully_approved is missing from the response body", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ satisfied_types: [] }));
    });

    const gate = createHttpApprovalGate(baseUrl);
    await expect(gate.hasRequiredApprovals("citizen-1", "suspend")).resolves.toBe(false);
  });
});

// Exercises createNatsAuditEmitter against a real spawned nats-server
// (ARCH-009 §2's "boot the real thing" convention, applied to a message
// broker -- ADR-023). Requires nats-server on PATH
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
    const storeDir = await mkdtemp(path.join(tmpdir(), "dd-identity-nats-"));
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

  it("IT-eventbus: publishes identity_event with the citizen AuditEvent as payload", async () => {
    const url = await startNatsServer();
    bus = await connectEventBus(url);
    await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });

    const emitter = createNatsAuditEmitter(bus);
    const occurredAt = new Date("2026-01-01T00:00:00.000Z");
    emitter.append({ entity: "citizen", entityId: "citizen-1", action: "suspended", occurredAt });

    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      void consume(bus!, { stream: AUDIT_APPEND_STREAM, durable: "test-consumer" }, (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(new TextDecoder().decode(data)));
      });
    });

    expect(received).toMatchObject({
      action_type: "identity_event",
      actor_ref: "identity-service",
      payload: { entity: "citizen", entityId: "citizen-1", action: "suspended", occurredAt: occurredAt.toISOString() },
    });
    expect(received.idempotency_key).toBeTypeOf("string");
  });
});
