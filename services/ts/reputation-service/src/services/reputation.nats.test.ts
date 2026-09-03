import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { connectEventBus, consume, ensureStream, type EventBus } from "@dd/event-bus";
import { AUDIT_APPEND_STREAM, AUDIT_APPEND_SUBJECT, createNatsAuditEmitter } from "./reputation.js";

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
    const storeDir = await mkdtemp(path.join(tmpdir(), "dd-reputation-nats-"));
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

  it("IT-eventbus: publishes system_update with the reputation record as payload", async () => {
    const url = await startNatsServer();
    bus = await connectEventBus(url);
    await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });

    const emitter = createNatsAuditEmitter(bus);
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    emitter.emit("reputation.record_created", {
      id: "rec-1",
      citizenId: "citizen-1",
      factorType: "disclosure",
      delta: 5,
      sourceRef: "coi-1",
      createdAt,
    });

    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      void consume(bus!, { stream: AUDIT_APPEND_STREAM, durable: "test-consumer" }, (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(new TextDecoder().decode(data)));
      });
    });

    expect(received).toMatchObject({
      action_type: "system_update",
      actor_ref: "reputation-service",
      payload: {
        event_type: "reputation.record_created",
        id: "rec-1",
        citizenId: "citizen-1",
        factorType: "disclosure",
        delta: 5,
        sourceRef: "coi-1",
        createdAt: createdAt.toISOString(),
      },
    });
  });
});
