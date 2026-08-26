import type { FastifyInstance } from "fastify";
import type { AuditEmitter, ThresholdChecker } from "../collaborators.js";
import type { Problem, ProblemStatus, SubmitProblemInput } from "../domain/types.js";
import {
  endorseProblem,
  getProblem,
  listProblems,
  submitProblem,
  transitionProblemStatus,
} from "../services/problems.js";
import type { Store } from "../store.js";

export interface ProblemRouteDeps {
  store: Store;
  audit: AuditEmitter;
  thresholdChecker: ThresholdChecker;
}

interface SubmitProblemBody {
  citizen_id: string;
  title: string;
  description: string;
  affected_area: string;
  candidate_scope: string;
}

interface SupportBody {
  citizen_id: string;
}

interface StatusBody {
  status: ProblemStatus;
}

function serializeProblem(problem: Problem) {
  return {
    id: problem.id,
    citizen_id: problem.citizenId,
    title: problem.title,
    description: problem.description,
    affected_area: problem.affectedArea,
    candidate_scope: problem.candidateScope,
    status: problem.status,
    created_at: problem.createdAt.toISOString(),
  };
}

const submitProblemSchema = {
  body: {
    type: "object",
    required: [
      "citizen_id",
      "title",
      "description",
      "affected_area",
      "candidate_scope",
    ],
    additionalProperties: false,
    properties: {
      citizen_id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      affected_area: { type: "string", minLength: 1 },
      candidate_scope: { type: "string", minLength: 1 },
    },
  },
};

const idParamsSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1 } },
  },
};

const supportSchema = {
  ...idParamsSchema,
  body: {
    type: "object",
    required: ["citizen_id"],
    additionalProperties: false,
    properties: {
      citizen_id: { type: "string", minLength: 1 },
    },
  },
};

const statusSchema = {
  ...idParamsSchema,
  body: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["open", "proposing", "closed"] },
    },
  },
};

export function registerProblemRoutes(
  app: FastifyInstance,
  deps: ProblemRouteDeps,
) {
  app.post<{ Body: SubmitProblemBody }>(
    "/problems",
    { schema: submitProblemSchema },
    async (request, reply) => {
      const body = request.body;
      const input: SubmitProblemInput = {
        citizenId: body.citizen_id,
        title: body.title,
        description: body.description,
        affectedArea: body.affected_area,
        candidateScope: body.candidate_scope,
      };
      const problem = submitProblem(deps.store, input, deps.audit);
      reply.code(201);
      return serializeProblem(problem);
    },
  );

  app.get("/problems", async () => {
    return listProblems(deps.store).map(serializeProblem);
  });

  app.get<{ Params: { id: string } }>(
    "/problems/:id",
    { schema: idParamsSchema },
    async (request) => {
      const problem = getProblem(deps.store, request.params.id);
      return serializeProblem(problem);
    },
  );

  app.post<{ Params: { id: string }; Body: SupportBody }>(
    "/problems/:id/support",
    { schema: supportSchema },
    async (request) => {
      const supportCount = endorseProblem(
        deps.store,
        request.params.id,
        request.body.citizen_id,
        deps.thresholdChecker,
      );
      return { support_count: supportCount };
    },
  );

  app.post<{ Params: { id: string }; Body: StatusBody }>(
    "/problems/:id/status",
    { schema: statusSchema },
    async (request) => {
      const problem = transitionProblemStatus(
        deps.store,
        request.params.id,
        request.body.status,
        deps.audit,
      );
      return serializeProblem(problem);
    },
  );
}
