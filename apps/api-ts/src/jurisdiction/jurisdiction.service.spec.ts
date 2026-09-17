import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { buildJurisdictionTree, JurisdictionService } from "./jurisdiction.service.js";
import { Jurisdiction } from "./jurisdiction.types.js";

const urls = testDatabaseUrls();

function jurisdiction(overrides: Partial<Jurisdiction> & { id: string }): Jurisdiction {
  return {
    parentId: null,
    name: overrides.id,
    scopeLevel: "municipality",
    boundaryRef: `ref-${overrides.id}`,
    status: "active",
    ...overrides,
  };
}

// SRV-002's "Read jurisdiction tree" sync read. Pure helper, asserted
// directly so nesting correctness doesn't depend on Postgres.
describe("buildJurisdictionTree", () => {
  it("nests a 3-level hierarchy (national -> regional -> municipality) regardless of input order", () => {
    const national = jurisdiction({ id: "national-1", scopeLevel: "national" });
    const regional = jurisdiction({ id: "regional-1", parentId: "national-1", scopeLevel: "regional" });
    const municipality = jurisdiction({ id: "muni-1", parentId: "regional-1", scopeLevel: "municipality" });

    for (const order of [
      [national, regional, municipality],
      [municipality, regional, national],
      [regional, national, municipality],
    ]) {
      const tree = buildJurisdictionTree(order);
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe("national-1");
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].id).toBe("regional-1");
      expect(tree[0].children[0].children).toHaveLength(1);
      expect(tree[0].children[0].children[0].id).toBe("muni-1");
      expect(tree[0].children[0].children[0].children).toHaveLength(0);
    }
  });

  it("treats every jurisdiction with parentId === null as a root", () => {
    const a = jurisdiction({ id: "a" });
    const b = jurisdiction({ id: "b" });
    const tree = buildJurisdictionTree([a, b]);
    expect(tree.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });
});

// jurisdiction/residency/jurisdiction_membership have no citizen-facing (or
// worker-facing) create op in this pass (ADR-030 "Jurisdiction module is
// read-only") -- fixtures below go in directly via the admin connection,
// the same way a real deployment would seed these tables, bypassing RLS
// the way `truncateAll` already does.
async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urls!.admin });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function insertJurisdiction(row: {
  id: string;
  parentId?: string | null;
  name: string;
  scopeLevel: string;
  boundaryRef: string;
  minResidencyDays?: number;
}): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO jurisdiction (id, parent_id, name, scope_level, boundary_ref, min_residency_days) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.parentId ?? null, row.name, row.scopeLevel, row.boundaryRef, row.minResidencyDays ?? 0],
    ),
  );
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

async function insertMembership(citizenId: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO jurisdiction_membership (id, citizen_id, jurisdiction_id) VALUES ($1, $2, $3)`, [
      randomUUID(),
      citizenId,
      jurisdictionId,
    ]),
  );
}

async function insertResidency(
  citizenId: string,
  jurisdictionId: string,
  opts: { verified: boolean; status: "active" | "ended"; startDaysAgo?: number },
): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO residency (id, citizen_id, jurisdiction_id, start_date, verified, status)
       VALUES ($1, $2, $3, CURRENT_DATE - $4::int, $5, $6)`,
      [randomUUID(), citizenId, jurisdictionId, opts.startDaysAgo ?? 0, opts.verified, opts.status],
    ),
  );
}

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises ARCH-023's RLS policies rather than just their SQL text
// (ADR-030), mirroring project.service.spec.ts. JurisdictionService now owns
// its Prisma calls directly (no repository indirection) -- these tests
// drive it through its public API only, not internal query helpers.
describe.skipIf(!urls)("JurisdictionService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: JurisdictionService;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();
    svc = new JurisdictionService(prisma);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  describe("getTree", () => {
    it("reads findAll() and assembles the nested tree", async () => {
      const nationalId = randomUUID();
      const regionalId = randomUUID();
      await insertJurisdiction({ id: nationalId, name: "Nation", scopeLevel: "national", boundaryRef: `ref-${nationalId}` });
      await insertJurisdiction({
        id: regionalId,
        parentId: nationalId,
        name: "Region",
        scopeLevel: "regional",
        boundaryRef: `ref-${regionalId}`,
      });

      const tree = await svc.getTree();
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe(nationalId);
      expect(tree[0].children[0].id).toBe(regionalId);
    });
  });

  describe("isMember", () => {
    it("is true when a jurisdiction_membership row exists for the pair", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "alice");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-m" });
      await insertMembership(citizenId, jurisdictionId);

      expect(await svc.isMember(citizenId, jurisdictionId)).toBe(true);
    });

    it("is false when no membership row exists for the pair", async () => {
      expect(await svc.isMember(randomUUID(), randomUUID())).toBe(false);
    });
  });

  // jurisdiction-membership.port.ts's own doc comment: isAffected is broader
  // than isMember -- member OR a verified resident of this jurisdiction.
  describe("isAffected", () => {
    it("is true via membership alone (no residency row at all)", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "bob");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-m2" });
      await insertMembership(citizenId, jurisdictionId);

      expect(await svc.isAffected(citizenId, jurisdictionId)).toBe(true);
    });

    it("is true via a verified active residency, without membership", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "carol");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-m3" });
      await insertResidency(citizenId, jurisdictionId, { verified: true, status: "active" });

      expect(await svc.isAffected(citizenId, jurisdictionId)).toBe(true);
    });

    it("is false when the residency exists but is not verified", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "dave");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-m4" });
      await insertResidency(citizenId, jurisdictionId, { verified: false, status: "active" });

      expect(await svc.isAffected(citizenId, jurisdictionId)).toBe(false);
    });

    it("is false when the residency is verified but ended (not active)", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "erin");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-m5" });
      await insertResidency(citizenId, jurisdictionId, { verified: true, status: "ended" });

      expect(await svc.isAffected(citizenId, jurisdictionId)).toBe(false);
    });

    it("is false when neither membership nor a verified active residency exists", async () => {
      expect(await svc.isAffected(randomUUID(), randomUUID())).toBe(false);
    });
  });

  // ADR-038 D7/D8: strict AND, unlike isAffected's OR.
  describe("isEligible", () => {
    it("is false with a verified qualifying residency but no membership", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "elig-1");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-e1", minResidencyDays: 180 });
      await insertResidency(citizenId, jurisdictionId, { verified: true, status: "active", startDaysAgo: 200 });

      expect(await svc.isEligible(citizenId, jurisdictionId)).toBe(false);
    });

    it("is false with membership but no residency", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "elig-2");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-e2" });
      await insertMembership(citizenId, jurisdictionId);

      expect(await svc.isEligible(citizenId, jurisdictionId)).toBe(false);
    });

    it("is false when residency is under the jurisdiction's minResidencyDays", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "elig-3");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-e3", minResidencyDays: 180 });
      await insertMembership(citizenId, jurisdictionId);
      await insertResidency(citizenId, jurisdictionId, { verified: true, status: "active", startDaysAgo: 30 });

      expect(await svc.isEligible(citizenId, jurisdictionId)).toBe(false);
    });

    it("is true with membership and a verified residency at least minResidencyDays old", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "elig-4");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-e4", minResidencyDays: 180 });
      await insertMembership(citizenId, jurisdictionId);
      await insertResidency(citizenId, jurisdictionId, { verified: true, status: "active", startDaysAgo: 200 });

      expect(await svc.isEligible(citizenId, jurisdictionId)).toBe(true);
    });

    it("is true with a zero minResidencyDays jurisdiction (property/street) and membership plus any verified residency", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "elig-5");
      await insertJurisdiction({ id: jurisdictionId, name: "Street", scopeLevel: "street", boundaryRef: "ref-e5", minResidencyDays: 0 });
      await insertMembership(citizenId, jurisdictionId);
      await insertResidency(citizenId, jurisdictionId, { verified: true, status: "active", startDaysAgo: 0 });

      expect(await svc.isEligible(citizenId, jurisdictionId)).toBe(true);
    });
  });

  describe("declareResidency / enrollMembership (E2-04)", () => {
    it("declareResidency creates an unverified residency row visible to isAffected but not isEligible", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "decl-1");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-decl-1" });

      await svc.declareResidency(citizenId, jurisdictionId, new Date());

      expect(await svc.isAffected(citizenId, jurisdictionId)).toBe(false); // unverified
      expect(await svc.isEligible(citizenId, jurisdictionId)).toBe(false);
    });

    it("enrollMembership creates a membership row usable by isMember/isAffected", async () => {
      const citizenId = randomUUID();
      const jurisdictionId = randomUUID();
      await insertCitizen(citizenId, "decl-2");
      await insertJurisdiction({ id: jurisdictionId, name: "Muni", scopeLevel: "municipality", boundaryRef: "ref-decl-2" });

      await svc.enrollMembership(citizenId, jurisdictionId);

      expect(await svc.isMember(citizenId, jurisdictionId)).toBe(true);
      expect(await svc.isAffected(citizenId, jurisdictionId)).toBe(true);
    });
  });
});
