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
  createHttpGovernanceRoleChecker,
  createNatsAuditEmitter,
} from "./collaborators.js";

// Exercises the real HTTP seam implementation against a minimal stand-in
// for governance-role-service's actual wire contract (SRV-011's
// GET /governance-roles/roles?citizen_id=...&role_type=..., src/routes/roles.ts),
// same pattern as identity-service's createHttpApprovalGate /
// governance-role-service's createHttpCOIChecker tests.

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

function roleRow(termStart: string, termEnd: string) {
  return { term_start: termStart, term_end: termEnd };
}

describe("createHttpGovernanceRoleChecker (integration)", () => {
  it("GETs /governance-roles/roles?citizen_id=...&role_type=... and returns true for a role whose term covers now", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([roleRow("2020-01-01T00:00:00Z", "2099-01-01T00:00:00Z")]));
    });

    const checker = createHttpGovernanceRoleChecker(baseUrl);
    const result = await checker.hasActiveRole("citizen-1", "operator");

    expect(receivedUrl).toBe("/governance-roles/roles?citizen_id=citizen-1&role_type=operator");
    expect(result).toBe(true);
  });

  it("URL-encodes the citizen id", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
    });

    const checker = createHttpGovernanceRoleChecker(baseUrl);
    await checker.hasActiveRole("citizen with spaces", "operator");

    expect(receivedUrl).toBe("/governance-roles/roles?citizen_id=citizen%20with%20spaces&role_type=operator");
  });

  it("returns false when governance-role-service returns no matching rows", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
    });

    const checker = createHttpGovernanceRoleChecker(baseUrl);
    await expect(checker.hasActiveRole("citizen-1", "operator")).resolves.toBe(false);
  });

  it("returns false for a role whose term has already ended (not currently active)", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([roleRow("2020-01-01T00:00:00Z", "2020-06-01T00:00:00Z")]));
    });

    const checker = createHttpGovernanceRoleChecker(baseUrl);
    await expect(checker.hasActiveRole("citizen-1", "operator")).resolves.toBe(false);
  });

  it("returns false for a role whose term has not started yet", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([roleRow("2099-01-01T00:00:00Z", "2100-01-01T00:00:00Z")]));
    });

    const checker = createHttpGovernanceRoleChecker(baseUrl);
    await expect(checker.hasActiveRole("citizen-1", "operator")).resolves.toBe(false);
  });

  it("fails closed (false) on a non-2xx response from governance-role-service", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });

    const checker = createHttpGovernanceRoleChecker(baseUrl);
    await expect(checker.hasActiveRole("citizen-1", "operator")).resolves.toBe(false);
  });

  it("fails closed (false) when governance-role-service is unreachable", async () => {
    const checker = createHttpGovernanceRoleChecker("http://127.0.0.1:1");
    await expect(checker.hasActiveRole("citizen-1", "operator")).resolves.toBe(false);
  });
});

// Exercises createNatsAuditEmitter against a real spawned nats-server
// (ARCH-009 §2's "boot the real thing" convention -- ADR-023). Requires
// nats-server on PATH (go install github.com/nats-io/nats-server/v2@latest).
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
    const storeDir = await mkdtemp(path.join(tmpdir(), "dd-iam-nats-"));
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

  it("IT-eventbus: publishes admin_action events with actor_ref iam-service", async () => {
    const url = await startNatsServer();
    bus = await connectEventBus(url);
    await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });

    const emitter = createNatsAuditEmitter(bus);
    emitter.emit("policy.activated", { policyId: "policy-1" });

    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      void consume(bus!, { stream: AUDIT_APPEND_STREAM, durable: "test-consumer" }, (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(new TextDecoder().decode(data)));
      });
    });

    expect(received).toMatchObject({
      action_type: "admin_action",
      actor_ref: "iam-service",
      payload: { event: "policy.activated", policyId: "policy-1" },
    });
    expect(received.idempotency_key).toBeTypeOf("string");
  });
});
