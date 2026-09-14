// Shared support for the Postgres-backed integration test tier: skipped
// automatically when the TEST_*_DATABASE_URL env vars are unset, so `pnpm
// test` stays dependency-free by default (mirrors apps/api-go's
// TEST_DATABASE_URL-gated pgtest_test.go pattern).
import { Client } from "pg";
import { PrismaService } from "../prisma/prisma.service.js";

export interface TestDatabaseUrls {
  app: string;
  worker: string;
  admin: string;
}

export function testDatabaseUrls(): TestDatabaseUrls | null {
  const app = process.env.TEST_DATABASE_URL;
  const worker = process.env.TEST_WORKER_DATABASE_URL;
  const admin = process.env.TEST_ADMIN_DATABASE_URL;
  if (!app || !worker || !admin) {
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
