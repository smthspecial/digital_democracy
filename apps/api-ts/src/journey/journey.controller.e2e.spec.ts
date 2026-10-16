import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AUDIT_EMITTER } from "../common/audit-emitter.js";
import { DomainErrorFilter } from "../common/domain-error.filter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ProposalService } from "../proposal/proposal.service.js";
import { installTestAuth, testBearer } from "../test-support/auth.js";
import { testInternalHeaders } from "../test-support/identity-verifier.js";
import {
  newTestPrismaService,
  testDatabaseUrls,
  truncateAll,
} from "../test-support/postgres.js";
import { JourneyModule } from "./journey.module.js";
import { JourneyService } from "./journey.service.js";
import { VotingRuntime } from "./voting-runtime.js";

const urls = testDatabaseUrls();

describe.skipIf(!urls)(
  "governance journey (HTTP, real restricted-role Postgres)",
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let journey: JourneyService;
    let proposalService: ProposalService;
    let citizen: string,
      jurisdiction: string,
      problem: string,
      proposal: string,
      session: string,
      option: string;
    let certified: Record<string, unknown>;
    const get = vi.fn();
    const emit = vi.fn().mockResolvedValue(undefined);

    beforeAll(async () => {
      vi.stubEnv("APP_ENV", "development");
      vi.stubEnv("INTERNAL_SERVICE_SHARED_SECRET", "test-internal-secret");
      prisma = newTestPrismaService(urls!);
      const module = await Test.createTestingModule({
        imports: [JourneyModule],
      })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(VotingRuntime)
        .useValue({ get })
        .overrideProvider(AUDIT_EMITTER)
        .useValue({ emit })
        .compile();
      app = module.createNestApplication({ rawBody: true });
      installTestAuth(app);
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.useGlobalFilters(new DomainErrorFilter());
      await app.init();
      journey = app.get(JourneyService);
      proposalService = app.get(ProposalService);
    });
    afterAll(async () => {
      await app?.close();
      vi.unstubAllEnvs();
    });
    beforeEach(async () => {
      await truncateAll(urls!);
      [citizen, jurisdiction, problem, proposal, session, option] = Array.from(
        { length: 6 },
        () => randomUUID(),
      );
      const admin = new Client({ connectionString: urls!.admin });
      await admin.connect();
      try {
        await admin.query(
          "INSERT INTO citizen(id,public_handle,legal_identity_hash,status) VALUES ($1,'journey-citizen','synthetic','active')",
          [citizen],
        );
        await admin.query(
          "INSERT INTO jurisdiction(id,name,scope_level,boundary_ref,population) VALUES ($1,'Test municipality','municipality','synthetic',100)",
          [jurisdiction],
        );
        await admin.query(
          "INSERT INTO problem(id,author_id,title,description,affected_area,jurisdiction_id) VALUES ($1,$2,'Issue','Problem statement','Test area',$3)",
          [problem, citizen, jurisdiction],
        );
        await admin.query(
          "INSERT INTO proposal(id,problem_id,author_id,title,description,scope_jurisdiction_id,support_threshold,status) VALUES ($1,$2,$3,'Solution','Proposed solution',$4,1,'voting')",
          [proposal, problem, citizen, jurisdiction],
        );
        await admin.query(
          "INSERT INTO proposal_budget(id,proposal_id,cost) VALUES ($1,$2,100)",
          [randomUUID(), proposal],
        );
      } finally {
        await admin.end();
      }
      certified = {
        id: session,
        proposal_id: proposal,
        jurisdiction_id: jurisdiction,
        status: "certified",
        tally_result: {
          vote_session_id: session,
          winner: option,
          decided: true,
          total_ballots: 1,
        },
      };
      get
        .mockReset()
        .mockImplementation(async (path: string) =>
          path.endsWith("/options")
            ? {
                options: [
                  {
                    id: option,
                    vote_session_id: session,
                    proposal_id: proposal,
                  },
                ],
              }
            : certified,
        );
      emit.mockClear();
    });

    it("shows missing voting information and never advertises unreviewed voting", async () => {
      const response = await request(app.getHttpServer()).get(
        `/journey/proposals/${proposal}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.problem.description).toBe("Problem statement");
      expect(response.body.eligible).toBeNull();
      expect(response.body.missing).toContain("Publish expert analysis");
      expect(response.body.voting.status).toBe("unavailable");
    });

    it("atomically approves and creates one public project across concurrent deliveries", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => journey.reconcile(session)),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(await prisma.app.project.count()).toBe(1);
      const row = await prisma.app.project.findFirstOrThrow();
      expect(row.certifiedVoteSessionId).toBe(session);
      expect(row.budgetAllocated?.toNumber()).toBe(100);
      expect(row.contractor).toBeNull();
      expect(row.timelineEnd).toBeNull();
      expect(
        (
          await prisma.app.proposal.findUniqueOrThrow({
            where: { id: proposal },
          })
        ).status,
      ).toBe("approved");
    });

    it("rejects anonymous notification and consumes a valid signed request only once", async () => {
      const path = `/journey/sessions/${session}/reconcile`;
      expect(
        (await request(app.getHttpServer()).post(path).send({})).status,
      ).toBe(401);
      const headers = testInternalHeaders(path, "POST", "{}");
      expect(
        (await request(app.getHttpServer()).post(path).set(headers).send({}))
          .status,
      ).toBe(201);
      expect(
        (await request(app.getHttpServer()).post(path).set(headers).send({}))
          .status,
      ).toBe(401);
    });

    it.each(["open", "closed"])(
      "does not approve a %s election",
      async (status) => {
        certified.status = status;
        await expect(journey.reconcile(session)).rejects.toThrow("certified");
        expect(await prisma.app.project.count()).toBe(0);
      },
    );

    it("does not approve undecided or forged winner results", async () => {
      certified.tally_result = {
        vote_session_id: session,
        winner: randomUUID(),
        decided: true,
        total_ballots: 1,
      };
      await expect(journey.reconcile(session)).rejects.toThrow(
        "frozen election option",
      );
      expect(await prisma.app.project.count()).toBe(0);
    });

    it("fails closed on voting service outage and succeeds on a later retry", async () => {
      get.mockRejectedValueOnce(new Error("fixture outage"));
      await expect(journey.reconcile(session)).rejects.toThrow(
        "fixture outage",
      );
      expect(await prisma.app.project.count()).toBe(0);
      await journey.reconcile(session);
      expect(await prisma.app.project.count()).toBe(1);
    });

    it("cannot replace the source of an existing project", async () => {
      await journey.reconcile(session);
      const other = randomUUID();
      certified.id = other;
      certified.tally_result = {
        vote_session_id: other,
        winner: option,
        decided: true,
        total_ballots: 1,
      };
      get.mockImplementation(async (path: string) =>
        path.endsWith("/options")
          ? {
              options: [
                { id: option, vote_session_id: other, proposal_id: proposal },
              ],
            }
          : certified,
      );
      await expect(journey.reconcile(other)).rejects.toThrow(
        "different approval source",
      );
      expect(await prisma.app.project.count()).toBe(1);
    });

    it("retains the production gate even with a valid synthetic result", async () => {
      vi.stubEnv("APP_ENV", "production");
      try {
        await expect(journey.reconcile(session)).rejects.toThrow(
          "reviewed ballot cryptography",
        );
      } finally {
        vi.stubEnv("APP_ENV", "development");
      }
      expect(await prisma.app.project.count()).toBe(0);
    });

    it("authors can edit objectives before voting; other citizens and frozen proposals cannot", async () => {
      const details = {
        objectives: "Safer street",
        measurableOutcomes: "Reduce incidents",
        implementationTimeline: "Six months after appointment",
      };
      await expect(
        proposalService.updateDetails(citizen, proposal, details),
      ).rejects.toThrow("frozen");
      await prisma.forWorker((tx) =>
        tx.proposal.update({
          where: { id: proposal },
          data: { status: "development" },
        }),
      );
      const path = `/proposal/proposals/${proposal}/details`;
      expect(
        (
          await request(app.getHttpServer())
            .post(path)
            .set("Authorization", testBearer(citizen))
            .send(details)
        ).status,
      ).toBe(201);
      expect(
        (
          await prisma.app.proposal.findUniqueOrThrow({
            where: { id: proposal },
          })
        ).objectives,
      ).toBe(details.objectives);
    });
  },
);
