import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { connectEventBus, consume, ensureStream, publish } from "./index.js";

// Spawns a real nats-server process with JetStream enabled, matching this
// codebase's "boot the real thing as a process, not a mock" convention
// (ARCH-009 §2). Requires nats-server on PATH
// (go install github.com/nats-io/nats-server/v2@latest).

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
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

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const conn = createConnection({ port, host: "127.0.0.1" });
      conn.once("connect", () => {
        conn.destroy();
        resolve(true);
      });
      conn.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`nats-server did not start listening on port ${port} in time`);
}

let natsProcess: ChildProcessByStdio<null, Readable, Readable> | undefined;

async function startNatsServer(): Promise<string> {
  const port = await freePort();
  const storeDir = await mkdtemp(path.join(tmpdir(), "nats-event-bus-test-"));
  natsProcess = spawn("nats-server", ["-p", String(port), "-js", "-sd", storeDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForPort(port, 5000);
  return `nats://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (natsProcess) {
    natsProcess.kill("SIGTERM");
    natsProcess = undefined;
  }
});

describe("@dd/event-bus (integration, against a real nats-server)", () => {
  it("publish/ensureStream/consume round-trips a JSON payload", async () => {
    const url = await startNatsServer();
    const bus = await connectEventBus(url);

    await ensureStream(bus, { name: "TEST_STREAM", subjects: ["test.subject"] });
    await publish(bus, "test.subject", { message: "hello" });

    const received = await new Promise<{ message: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for consumed message")), 3000);
      void consume(bus, { stream: "TEST_STREAM", durable: "test-consumer" }, (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(new TextDecoder().decode(data)));
      });
    });

    expect(received).toEqual({ message: "hello" });
    await bus.close();
  });

  it("redelivers a message when the handler throws, and stops once it succeeds", async () => {
    const url = await startNatsServer();
    const bus = await connectEventBus(url);

    await ensureStream(bus, { name: "REDELIVER_STREAM", subjects: ["redeliver.subject"] });
    await publish(bus, "redeliver.subject", { k: "v" });

    let attempts = 0;
    const secondAttempt = new Promise<number>((resolve) => {
      void consume(bus, { stream: "REDELIVER_STREAM", durable: "redeliver-consumer" }, () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error("simulated processing failure");
        }
        resolve(attempts);
      });
    });

    const result = await Promise.race([
      secondAttempt,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000)),
    ]);
    expect(result).toBe(2);
    await bus.close();
  });
});
