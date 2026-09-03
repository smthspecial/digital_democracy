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
