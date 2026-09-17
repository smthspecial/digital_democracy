// Shared support for the Postgres-backed integration test tier: skipped
// automatically when the TEST_TS_*_DATABASE_URL env vars are unset, so `pnpm
// test` stays dependency-free by default (mirrors apps/api-go's
// TEST_DATABASE_URL-gated pgtest_test.go pattern). Deliberately TEST_TS_*,
// not TEST_* -- apps/api-go's own pgtest_test.go files (auth, voting,
// delegation, audit) read the unprefixed TEST_DATABASE_URL expecting the
// api_go database; a shared CI/dev shell that exports one TEST_DATABASE_URL
// for "the test database" would point one runtime's suite at the other
// runtime's schema. Set REQUIRE_DB_TESTS=1 to turn a missing/incomplete
// trio from a silent skip into a thrown error (CI sets this; local `pnpm
// test` does not, so it stays dependency-free by default).
import { Client } from "pg";
import { PrismaService } from "../prisma/prisma.service.js";

export interface TestDatabaseUrls {
  app: string;
  worker: string;
  admin: string;
}

const REQUIRED_VARS = ["TEST_TS_DATABASE_URL", "TEST_TS_WORKER_DATABASE_URL", "TEST_TS_ADMIN_DATABASE_URL"] as const;

export function testDatabaseUrls(): TestDatabaseUrls | null {
  const app = process.env.TEST_TS_DATABASE_URL;
  const worker = process.env.TEST_TS_WORKER_DATABASE_URL;
  const admin = process.env.TEST_TS_ADMIN_DATABASE_URL;
  if (!app || !worker || !admin) {
    if (process.env.REQUIRE_DB_TESTS) {
      const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
      throw new Error(
        `REQUIRE_DB_TESTS is set but missing env var(s): ${missing.join(", ")} -- the Postgres-backed test ` +
          `tier would otherwise silently skip with zero assertions (this is how the audit-emitter bug survived).`,
      );
    }
    return null;
  }
  return { app, worker, admin };
}

export function newTestPrismaService(urls: TestDatabaseUrls): PrismaService {
  return new PrismaService({ appUrl: urls.app, workerUrl: urls.worker });
}

// RLS-scoped roles (api_app/api_worker) aren't granted TRUNCATE -- runs as
// the migration's admin connection instead.
export async function truncateAll(urls: TestDatabaseUrls): Promise<void> {
  const client = new Client({ connectionString: urls.admin });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE TABLE policy_endorsement, policy_attachment, access_policy,
         outcome_evaluation, project_milestone, project, reputation_record,
         participation_record, civic_assignment,
         approval, governance_role, ledger_entry, budget_allocation_vote, budget_category,
         deliberation_argument, preference, expert_assessment, conflict_of_interest,
         competency_challenge, competency, expert_domain,
         proposal_budget, proposal_constraint, proposal, problem_support, problem,
         jurisdiction_membership, residency, jurisdiction, identity_verification, citizen
       RESTART IDENTITY CASCADE`,
    );
  } finally {
    await client.end();
  }
}
