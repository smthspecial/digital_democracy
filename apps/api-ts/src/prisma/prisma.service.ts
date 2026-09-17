import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// Two connections against the same schema (ADR-030): `app` authenticates as
// the `api_app` Postgres role (RLS-scoped to the acting citizen via
// SET LOCAL app.citizen_id, see forCitizen), `worker` authenticates as
// `api_worker` (broad USING(true) policies, ARCH-023 §4.3) for the small set
// of system-only steps this pass needs (DP-002's citizen:activate).
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly app: PrismaClient;
  readonly worker: PrismaClient;

  // `urls` overrides env vars -- used by integration tests to point at
  // TEST_TS_DATABASE_URL/TEST_TS_WORKER_DATABASE_URL instead of the dev/prod ones.
  // @Optional() -- its design:paramtype is a plain object literal, not an
  // injectable class/token, so without it Nest's real DI container (as
  // opposed to every spec's `new PrismaService(...)`/provider-override
  // construction) throws UnknownDependenciesException trying to resolve it.
  constructor(@Optional() urls?: { appUrl: string; workerUrl: string }) {
    this.app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: urls?.appUrl ?? requireEnv("DATABASE_URL") }),
    });
    this.worker = new PrismaClient({
      adapter: new PrismaPg({ connectionString: urls?.workerUrl ?? requireEnv("WORKER_DATABASE_URL") }),
    });
  }

  async onModuleInit() {
    await Promise.all([this.app.$connect(), this.worker.$connect()]);
  }

  async onModuleDestroy() {
    await Promise.all([this.app.$disconnect(), this.worker.$disconnect()]);
  }

  // Runs `work` inside a transaction on the `api_app` connection with
  // app.citizen_id set for the duration of the transaction (ARCH-023 §3).
  // `citizenId` is undefined for unauthenticated calls (e.g. DP-001
  // registration) -- current_citizen_id() then reads as NULL in policies.
  forCitizen<T>(citizenId: string | undefined, work: (tx: PrismaTx) => Promise<T>): Promise<T> {
    return this.app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.citizen_id', ${citizenId ?? ""}, true)`;
      return work(tx as PrismaTx);
    });
  }

  // Runs `work` on the `api_worker` connection (ARCH-023 §2(b)): internal
  // system steps, e.g. DP-002's citizen:activate.
  forWorker<T>(work: (tx: PrismaTx) => Promise<T>): Promise<T> {
    return this.worker.$transaction(async (tx) => work(tx as PrismaTx));
  }
}

export type PrismaTx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
