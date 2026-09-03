// ARCH-009 §2's integration/e2e tooling contract, taken literally for a flow
// that spans more than one service: no docker-compose, no shared test
// infrastructure -- each real service is booted as its own process (its own
// entrypoint, its own runtime -- tsx for TS, a compiled binary for Go) on a
// fixed local port and reached over real HTTP, exactly the way one service
// reaches another in a real deployment. This intentionally does NOT import
// another package's buildServer() in-process: that would only be possible
// for the TS services (Go can't be in-process here at all), and mixing "some
// services in-process, others out-of-process" would make the two kinds of
// scenario inconsistent with each other for no real benefit -- every
// scenario in this suite gets the same real-process treatment.
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;

const execFileAsync = promisify(execFile);

export interface SpawnedService {
  baseUrl: string;
  stderr(): string;
  stop(): Promise<void>;
}

const TS_SERVICES_DIR = path.resolve(import.meta.dirname, "../../..");
const GO_SERVICES_DIR = path.resolve(import.meta.dirname, "../../../../go");

async function waitForHealth(
  baseUrl: string,
  child: SpawnedChild,
  getStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`process exited early (code ${child.exitCode}) before becoming healthy:\n${getStderr()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet -- keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${baseUrl}/healthz did not become healthy in time:\n${getStderr()}`);
}

function captureStderr(child: SpawnedChild): () => string {
  let buf = "";
  child.stderr.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
  });
  return () => buf;
}

async function stopChild(child: SpawnedChild): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Spawns a TS service's real entrypoint (`tsx src/index.ts`) as its own process. */
export async function spawnTsService(name: string, port: number, env: Record<string, string> = {}): Promise<SpawnedService> {
  const dir = path.join(TS_SERVICES_DIR, name);
  const tsxBin = path.join(dir, "node_modules", ".bin", "tsx");
  const child = spawn(tsxBin, ["src/index.ts"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const getStderr = captureStderr(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, getStderr);
  return { baseUrl, stderr: getStderr, stop: () => stopChild(child) };
}

async function waitForPort(port: number, child: SpawnedChild, getStderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`process exited early (code ${child.exitCode}) before becoming ready:\n${getStderr()}`);
    }
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
  throw new Error(`nats-server did not start listening on port ${port} in time:\n${getStderr()}`);
}

/**
 * Spawns a real nats-server process with JetStream enabled (ADR-023).
 * Requires nats-server on PATH (go install github.com/nats-io/nats-server/v2@latest).
 * Unlike the HTTP services above, readiness is a raw TCP connect, not
 * /healthz -- nats-server's client port doesn't speak HTTP.
 */
export async function spawnNatsServer(port: number): Promise<SpawnedService> {
  const storeDir = await mkdtemp(path.join(tmpdir(), "dd-e2e-nats-"));
  const child = spawn("nats-server", ["-p", String(port), "-js", "-sd", storeDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const getStderr = captureStderr(child);
  await waitForPort(port, child, getStderr);
  return {
    baseUrl: `nats://127.0.0.1:${port}`,
    stderr: getStderr,
    async stop() {
      await stopChild(child);
      await rm(storeDir, { recursive: true, force: true });
    },
  };
}

/** Builds and spawns a Go service's real compiled binary as its own process. */
export async function spawnGoService(name: string, port: number, env: Record<string, string> = {}): Promise<SpawnedService> {
  const dir = path.join(GO_SERVICES_DIR, name);
  const buildDir = await mkdtemp(path.join(tmpdir(), "dd-e2e-"));
  const binPath = path.join(buildDir, name);
  await execFileAsync("go", ["build", "-o", binPath, "."], { cwd: dir });

  const child = spawn(binPath, [], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const getStderr = captureStderr(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child, getStderr);
  return {
    baseUrl,
    stderr: getStderr,
    async stop() {
      await stopChild(child);
      await rm(buildDir, { recursive: true, force: true });
    },
  };
}
