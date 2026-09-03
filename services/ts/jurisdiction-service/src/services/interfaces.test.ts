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
  createNatsAuditEmitter,
} from "./interfaces.js";

// Exercises createHttpApprovalGate against a minimal stand-in for
// governance-role-service's real wire contract (SRV-011's
// GET /governance-roles/actions/:actionRef/status), the same pattern
// identity-service's collaborators.test.ts uses for its own
// createHttpApprovalGate. ARCH-011 EC-31.

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

describe("createHttpApprovalGate (integration)", () => {
  it("IT-011-EC-31: GETs the jurisdiction:scope-level:{id} action_ref and reads fully_approved", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fully_approved: true }));
    });

    const gate = createHttpApprovalGate(baseUrl);
    const result = await gate("jurisdiction-1");

    expect(receivedUrl).toBe("/governance-roles/actions/jurisdiction%3Ascope-level%3Ajurisdiction-1/status");
    expect(result).toBe(true);
  });

  it("IT-011-EC-31: fails closed (false) on a non-2xx response", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });

    const gate = createHttpApprovalGate(baseUrl);
    await expect(gate("jurisdiction-1")).resolves.toBe(false);
  });

  it("IT-011-EC-31: fails closed (false) when governance-role-service is unreachable", async () => {
    const gate = createHttpApprovalGate("http://127.0.0.1:1");
    await expect(gate("jurisdiction-1")).resolves.toBe(false);
  });

  it("fails closed (false) when fully_approved is missing from the response body", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ satisfied_approval_types: [] }));
    });

    const gate = createHttpApprovalGate(baseUrl);
    await expect(gate("jurisdiction-1")).resolves.toBe(false);
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
    const storeDir = await mkdtemp(path.join(tmpdir(), "dd-jurisdiction-nats-"));
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

  it("IT-eventbus: publishes admin_action with the original event_type folded into the payload", async () => {
    const url = await startNatsServer();
    bus = await connectEventBus(url);
    await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });

    const emitter = createNatsAuditEmitter(bus);
    emitter("jurisdiction.scope_level_changed", { jurisdiction_id: "j1", scope_level: "regional" });

    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      void consume(bus!, { stream: AUDIT_APPEND_STREAM, durable: "test-consumer" }, (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(new TextDecoder().decode(data)));
      });
    });

    expect(received).toMatchObject({
      action_type: "admin_action",
      actor_ref: "jurisdiction-service",
      payload: { event_type: "jurisdiction.scope_level_changed", jurisdiction_id: "j1", scope_level: "regional" },
    });
  });
});
