import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictDomainError, ForbiddenDomainError } from "../common/domain-errors.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { GovernanceRoleService } from "./governance-role.service.js";

const urls = testDatabaseUrls();

function daysFromToday(offset: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

// term_start/term_end are DATE columns -- send date-only text so Postgres
// doesn't have to reinterpret a full timestamp.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urls!.admin });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function insertCitizen(id: string, publicHandle: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO citizen (id, public_handle, legal_identity_hash) VALUES ($1, $2, $3)`, [
      id,
      publicHandle,
      `hash-${id}`,
    ]),
  );
}

async function insertGovernanceRole(
  id: string,
  citizenId: string,
  opts: { roleType?: string; layer?: string; termStart: Date; termEnd: Date; randomized?: boolean },
): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO governance_role (id, citizen_id, role_type, layer, term_start, term_end, randomized)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        citizenId,
        opts.roleType ?? "auditor",
        opts.layer ?? "audit",
        isoDate(opts.termStart),
        isoDate(opts.termEnd),
        opts.randomized ?? false,
      ],
    ),
  );
}

// Seeds a governance_role row for citizenId and returns its id -- mirrors
// the deleted governance-role.repository.memory.ts-backed spec's `role()` +
// repo.seedRole(...) pair, now against real Postgres.
async function seedRole(
  citizenId: string,
  overrides: { roleType?: string; layer?: string; termStart?: Date; termEnd?: Date; randomized?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await insertGovernanceRole(id, citizenId, {
    roleType: overrides.roleType ?? "auditor",
    layer: overrides.layer ?? "audit",
    termStart: overrides.termStart ?? daysFromToday(-30),
    termEnd: overrides.termEnd ?? daysFromToday(30),
    randomized: overrides.randomized ?? false,
  });
  return id;
}

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises governance_role/approval's RLS policies rather than just
// their SQL text, mirroring project.service.spec.ts. GovernanceRoleService
// now owns its Prisma calls directly (no repository indirection) -- these
// tests drive it through its public API only, not internal query helpers.
describe.skipIf(!urls)("GovernanceRoleService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: GovernanceRoleService;
  let citizenStatus: CitizenStatusChecker;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let activeCitizens: Set<string>;
  let CITIZEN: string;
  let OTHER: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    CITIZEN = randomUUID();
    OTHER = randomUUID();
    await insertCitizen(CITIZEN, "citizen-1");
    await insertCitizen(OTHER, "citizen-2");

    activeCitizens = new Set([CITIZEN, OTHER]);
    citizenStatus = { isActive: vi.fn(async (citizenId: string) => activeCitizens.has(citizenId)) };
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new GovernanceRoleService(prisma, citizenStatus, audit);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  // DP-023: approval:submit -- AUTH-010's approval:submit:operator/:council
  // rows, scope any, condition role.term.
  describe("submitApproval (DP-023, AUTH-010 approval:submit:operator/:council)", () => {
    it("rejects an inactive citizen", async () => {
      activeCitizens.delete(CITIZEN);
      await expect(
        svc.submitApproval(CITIZEN, {
          actionRef: "action-1",
          approvalType: "audit_confirmation",
          decision: "approved",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects a citizen approving their own identity revocation (ADR-034 D3/E1-11)", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      await expect(
        svc.submitApproval(CITIZEN, {
          actionRef: `identity:revoke:${CITIZEN}`,
          approvalType: "audit_confirmation",
          decision: "approved",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("allows approving someone else's identity revocation", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      const approval = await svc.submitApproval(CITIZEN, {
        actionRef: `identity:revoke:${OTHER}`,
        approvalType: "audit_confirmation",
        decision: "approved",
      });
      expect(approval.actionRef).toBe(`identity:revoke:${OTHER}`);
    });

    it("rejects a citizen who holds no governance_role at all", async () => {
      await expect(
        svc.submitApproval(CITIZEN, {
          actionRef: "action-1",
          approvalType: "audit_confirmation",
          decision: "approved",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects a citizen whose only role's term has already expired", async () => {
      await seedRole(CITIZEN, { termStart: daysFromToday(-60), termEnd: daysFromToday(-1) });
      await expect(
        svc.submitApproval(CITIZEN, {
          actionRef: "action-1",
          approvalType: "audit_confirmation",
          decision: "approved",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects a citizen whose only role's term has not started yet", async () => {
      await seedRole(CITIZEN, { termStart: daysFromToday(1), termEnd: daysFromToday(60) });
      await expect(
        svc.submitApproval(CITIZEN, {
          actionRef: "action-1",
          approvalType: "audit_confirmation",
          decision: "approved",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("succeeds for a citizen holding a currently live-term role, recording the role as approverRoleId", async () => {
      const roleId = await seedRole(CITIZEN);
      const approval = await svc.submitApproval(CITIZEN, {
        actionRef: "action-1",
        approvalType: "audit_confirmation",
        decision: "approved",
      });
      expect(approval.approverRoleId).toBe(roleId);
      expect(approval.actionRef).toBe("action-1");
      expect(approval.approvalType).toBe("audit_confirmation");
      expect(approval.decision).toBe("approved");
    });

    it("emits exactly one audit event per successful submission", async () => {
      await seedRole(CITIZEN, { layer: "protocol" });
      await svc.submitApproval(CITIZEN, {
        actionRef: "action-1",
        approvalType: "body_endorsement",
        decision: "approved",
      });
      expect(audit.emit).toHaveBeenCalledTimes(1);
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: expect.stringContaining("approval"), actorRef: CITIZEN }),
      );
    });

    // Judgment call #4: per CITIZEN, not merely per governance_role row --
    // the @@unique([actionRef, approverRoleId]) DB index alone only catches
    // the same-role case.
    it("rejects a second submission by the SAME citizen for the SAME actionRef, even via a different role/approvalType", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      await svc.submitApproval(CITIZEN, {
        actionRef: "action-1",
        approvalType: "audit_confirmation",
        decision: "approved",
      });

      // The citizen now also holds a second, independent role -- the SAME
      // action_ref must still be blocked.
      await seedRole(CITIZEN, { roleType: "reviewer", layer: "protocol" });
      await expect(
        svc.submitApproval(CITIZEN, {
          actionRef: "action-1",
          approvalType: "body_endorsement",
          decision: "rejected",
        }),
      ).rejects.toBeInstanceOf(ConflictDomainError);
    });

    it("allows a DIFFERENT citizen to submit an approval for the same actionRef", async () => {
      await seedRole(CITIZEN);
      const roleBId = await seedRole(OTHER, { layer: "protocol" });
      await svc.submitApproval(CITIZEN, {
        actionRef: "action-1",
        approvalType: "audit_confirmation",
        decision: "approved",
      });
      const second = await svc.submitApproval(OTHER, {
        actionRef: "action-1",
        approvalType: "body_endorsement",
        decision: "approved",
      });
      expect(second.approverRoleId).toBe(roleBId);
    });

    it("allows the SAME citizen to submit approvals for DIFFERENT actionRefs", async () => {
      await seedRole(CITIZEN);
      await svc.submitApproval(CITIZEN, {
        actionRef: "action-1",
        approvalType: "audit_confirmation",
        decision: "approved",
      });
      await seedRole(CITIZEN, { layer: "protocol" });
      const second = await svc.submitApproval(CITIZEN, {
        actionRef: "action-2",
        approvalType: "body_endorsement",
        decision: "approved",
      });
      expect(second.actionRef).toBe("action-2");
    });

    it("allows two DIFFERENT citizens to submit the SAME approvalType for the same actionRef (EC-25)", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      await seedRole(OTHER, { roleType: "auditor" });
      const first = await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      const second = await svc.submitApproval(OTHER, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      expect(first.approverRoleId).not.toBe(second.approverRoleId);
      expect(await svc.isFullyApproved("action-1")).toBe(false);
    });

    it("accepts an approver whose term starts exactly today (EC-29)", async () => {
      await seedRole(CITIZEN, { termStart: daysFromToday(0), termEnd: daysFromToday(30) });
      const approval = await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      expect(approval.actionRef).toBe("action-1");
    });

    it("accepts an approver whose term ends exactly today, rejects one millisecond after (EC-30)", async () => {
      await seedRole(CITIZEN, { termStart: daysFromToday(-30), termEnd: daysFromToday(0) });
      const approval = await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      expect(approval.actionRef).toBe("action-1");

      await seedRole(OTHER, { termStart: daysFromToday(-31), termEnd: daysFromToday(-1) });
      await expect(
        svc.submitApproval(OTHER, { actionRef: "action-2", approvalType: "audit_confirmation", decision: "approved" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("a fourth approval duplicating an already-satisfied type still succeeds, with no regression (EC-33)", async () => {
      const third = randomUUID();
      await insertCitizen(third, "citizen-3");
      activeCitizens.add(third);

      await seedRole(CITIZEN, { roleType: "auditor" });
      await seedRole(OTHER, { roleType: "review_body", layer: "protocol" });
      await seedRole(third, { roleType: "reviewer" });

      await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      await svc.submitApproval(OTHER, { actionRef: "action-1", approvalType: "body_endorsement", decision: "approved" });
      expect(await svc.isFullyApproved("action-1")).toBe(true);

      const fourth = await svc.submitApproval(third, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      expect(fourth.actionRef).toBe("action-1");
      expect(await svc.isFullyApproved("action-1")).toBe(true);
    });

    it("of two concurrent submissions by the same citizen for the same actionRef, exactly one succeeds (EC-37)", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      const results = await Promise.allSettled([
        svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" }),
        svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictDomainError);
    });
  });

  // GOVERNANCE_ROLE_CHECKER port -- the load-bearing contract for
  // project-service/iam-service's next two phases.
  describe("isActiveHolder (GOVERNANCE_ROLE_CHECKER port)", () => {
    it("is true when the citizen holds a currently live-term role of that type", async () => {
      await seedRole(CITIZEN, { roleType: "operator" });
      expect(await svc.isActiveHolder(CITIZEN, "operator")).toBe(true);
    });

    it("is false when the citizen holds no role at all", async () => {
      expect(await svc.isActiveHolder(CITIZEN, "operator")).toBe(false);
    });

    it("is false when the citizen's only role is a different roleType", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      expect(await svc.isActiveHolder(CITIZEN, "operator")).toBe(false);
    });

    it("is false once the role's term has expired", async () => {
      await seedRole(CITIZEN, { roleType: "operator", termStart: daysFromToday(-60), termEnd: daysFromToday(-1) });
      expect(await svc.isActiveHolder(CITIZEN, "operator")).toBe(false);
    });
  });

  // ApprovalGateChecker port -- ADR-034 D1's 2-of-2 gate.
  describe("isFullyApproved (APPROVAL_GATE port, ADR-034 D1)", () => {
    it("is false with no approvals at all", async () => {
      expect(await svc.isFullyApproved("identity:revoke:x")).toBe(false);
    });

    it("is false with only one of the two required approval types", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      expect(await svc.isFullyApproved("action-1")).toBe(false);
    });

    it("is false when both approvals come from the same citizen (even under different roles)", async () => {
      const roleA = await seedRole(CITIZEN, { roleType: "auditor" });
      await insertGovernanceRole(randomUUID(), CITIZEN, {
        roleType: "review_body",
        termStart: daysFromToday(-30),
        termEnd: daysFromToday(30),
      });
      await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      // Second approval under the same citizen's other active role would be
      // blocked by submitApproval's own per-citizen check -- verify the gate
      // itself independently by inserting directly.
      await withAdmin((client) =>
        client.query(
          `INSERT INTO approval (id, action_ref, approver_role_id, approval_type, decision)
           SELECT $1, $2, gr.id, $3, $4 FROM governance_role gr WHERE gr.citizen_id = $5 AND gr.role_type = 'review_body'`,
          [randomUUID(), "action-1", "body_endorsement", "approved", CITIZEN],
        ),
      );
      expect(roleA).toBeTruthy();
      expect(await svc.isFullyApproved("action-1")).toBe(false);
    });

    it("is false when both approvals share the same role type, from different citizens", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      await seedRole(OTHER, { roleType: "auditor", layer: "protocol" });
      await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      await svc.submitApproval(OTHER, { actionRef: "action-1", approvalType: "body_endorsement", decision: "approved" });
      expect(await svc.isFullyApproved("action-1")).toBe(false);
    });

    it("is true with audit_confirmation + body_endorsement from distinct citizens holding distinct role types", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      await seedRole(OTHER, { roleType: "review_body", layer: "protocol" });
      await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      await svc.submitApproval(OTHER, { actionRef: "action-1", approvalType: "body_endorsement", decision: "approved" });
      expect(await svc.isFullyApproved("action-1")).toBe(true);
    });

    it("is false when one of the two approvals was rejected", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      await seedRole(OTHER, { roleType: "review_body", layer: "protocol" });
      await svc.submitApproval(CITIZEN, { actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
      await svc.submitApproval(OTHER, { actionRef: "action-1", approvalType: "body_endorsement", decision: "rejected" });
      expect(await svc.isFullyApproved("action-1")).toBe(false);
    });
  });

  describe("listRoles / listApprovals (public reads)", () => {
    it("listRoles is a pass-through, optionally filtered by citizenId", async () => {
      await seedRole(CITIZEN, { roleType: "auditor" });
      await seedRole(OTHER, { roleType: "reviewer" });
      expect(await svc.listRoles()).toHaveLength(2);
      expect(await svc.listRoles({ citizenId: CITIZEN })).toHaveLength(1);
    });

    it("listApprovals is a pass-through, optionally filtered by actionRef", async () => {
      await seedRole(CITIZEN);
      await svc.submitApproval(CITIZEN, {
        actionRef: "action-1",
        approvalType: "audit_confirmation",
        decision: "approved",
      });

      expect(await svc.listApprovals()).toHaveLength(1);
      expect(await svc.listApprovals({ actionRef: "action-1" })).toHaveLength(1);
      expect(await svc.listApprovals({ actionRef: "action-none" })).toHaveLength(0);
    });
  });
});
