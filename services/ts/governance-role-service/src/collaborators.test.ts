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
  createHttpCOIChecker,
  createNatsAuditEmitter,
} from "./collaborators.js";

// Exercises createHttpCOIChecker against a minimal stand-in for
// competency-service's real wire contract (SRV-005's
// GET /competency/conflicts?citizen_id=...), same pattern as
// identity-service's createHttpSessionRevoker/createHttpApprovalGate tests.
// ARCH-010 EC-8, EC-16 (fail-closed, applied symmetrically to this seam).

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

describe("createHttpCOIChecker (integration)", () => {
  it("IT-010-EC-8: GETs /competency/conflicts?citizen_id=... and reads has_conflict", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ citizen_id: "citizen-1", has_conflict: true, domain_ids: ["energy"] }));
    });

    const checker = createHttpCOIChecker(baseUrl);
    const result = await checker.hasConflict("citizen-1", "identity:suspend:citizen-1");

    expect(receivedUrl).toBe("/competency/conflicts?citizen_id=citizen-1");
    expect(result).toBe(true);
  });

  it("returns false when the citizen has no declared conflicts", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ citizen_id: "citizen-1", has_conflict: false, domain_ids: [] }));
    });

    const checker = createHttpCOIChecker(baseUrl);
    await expect(checker.hasConflict("citizen-1", "identity:suspend:citizen-1")).resolves.toBe(false);
  });

  it("URL-encodes the citizen id", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ has_conflict: false }));
    });

    const checker = createHttpCOIChecker(baseUrl);
    await checker.hasConflict("citizen with spaces", "identity:suspend:x");

    expect(receivedUrl).toBe("/competency/conflicts?citizen_id=citizen%20with%20spaces");
  });

  it("IT-010-EC-16: fails closed (true, i.e. treated as a conflict) on a non-2xx response", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });

    const checker = createHttpCOIChecker(baseUrl);
    await expect(checker.hasConflict("citizen-1", "identity:suspend:citizen-1")).resolves.toBe(true);
  });

  it("IT-010-EC-16: fails closed (true) when competency-service is unreachable", async () => {
    const checker = createHttpCOIChecker("http://127.0.0.1:1");
    await expect(checker.hasConflict("citizen-1", "identity:suspend:citizen-1")).resolves.toBe(true);
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
    const storeDir = await mkdtemp(path.join(tmpdir(), "dd-governance-nats-"));
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

  it("IT-eventbus: maps protocol_change.executed to rule_change and everything else to admin_action", async () => {
    const url = await startNatsServer();
    bus = await connectEventBus(url);
    await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });

    const emitter = createNatsAuditEmitter(bus);
    emitter.emit("protocol_change.executed", { actionRef: "action-1" });
    emitter.emit("governance_role.created", { roleId: "role-1" });

    const seen: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for messages")), 3000);
      void consume(bus!, { stream: AUDIT_APPEND_STREAM, durable: "test-consumer" }, (data) => {
        const body = JSON.parse(new TextDecoder().decode(data)) as { action_type: string };
        seen.push(body.action_type);
        if (seen.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    expect(seen).toEqual(["rule_change", "admin_action"]);
  });
});
