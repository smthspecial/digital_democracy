import type { FastifyInstance } from "fastify";
import { EFFECTS, ENDORSEMENT_DECISIONS, POLICY_STATUSES } from "../domain/types.js";
import type { Effect, EndorsementDecision, PolicyStatus } from "../domain/types.js";
import type { Deps } from "../deps.js";
import { serializeEndorsement, serializePolicy } from "../serializers.js";
import { endorsePolicy, listPolicies, proposePolicy, revokePolicy } from "../services/policies.js";

interface ProposePolicyBody {
  name: string;
  effect: Effect;
  actions: string[];
  resources: string[];
  conditions?: Record<string, unknown> | null;
  description: string;
  proposed_by: string;
}

interface ListPoliciesQuery {
  status?: PolicyStatus;
}

interface EndorsePolicyBody {
  endorser_citizen_id: string;
  decision: EndorsementDecision;
}

interface RevokePolicyBody {
  revoked_by: string;
}

interface PolicyIdParams {
  id: string;
}

const proposePolicyBodySchema = {
  type: "object",
  required: ["name", "effect", "actions", "resources", "description", "proposed_by"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    effect: { type: "string", enum: EFFECTS },
    actions: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    resources: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    conditions: { type: ["object", "null"] },
    description: { type: "string" },
    proposed_by: { type: "string", minLength: 1 },
  },
} as const;

const listPoliciesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: POLICY_STATUSES },
  },
} as const;

const endorsePolicyBodySchema = {
  type: "object",
  required: ["endorser_citizen_id", "decision"],
  additionalProperties: false,
  properties: {
    endorser_citizen_id: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ENDORSEMENT_DECISIONS },
  },
} as const;

const revokePolicyBodySchema = {
  type: "object",
  required: ["revoked_by"],
  additionalProperties: false,
  properties: {
    revoked_by: { type: "string", minLength: 1 },
  },
} as const;

const policyIdParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
  },
} as const;

// DP-069/070/072 over TBL-040, via services/policies.ts -- this route module
// only does fastify schema validation + wire (snake_case) <-> domain
// (camelCase) translation; every actual eligibility/state-machine rule lives
// in services/policies.ts + dual-control.ts (ARCH-024 §2/§5).
export function registerPolicyRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: ProposePolicyBody }>(
    "/iam/policies",
    { schema: { body: proposePolicyBodySchema } },
    async (req, reply) => {
      const policy = await proposePolicy(deps.store, deps.governanceRoleChecker, deps.auditEmitter, {
        name: req.body.name,
        effect: req.body.effect,
        actions: req.body.actions,
        resources: req.body.resources,
        conditions: req.body.conditions ?? null,
        description: req.body.description,
        proposedBy: req.body.proposed_by,
      });
      reply.status(201);
      return serializePolicy(policy);
    },
  );

  app.get<{ Querystring: ListPoliciesQuery }>(
    "/iam/policies",
    { schema: { querystring: listPoliciesQuerySchema } },
    async (req) => {
      const policies = listPolicies(deps.store, { status: req.query.status });
      return policies.map(serializePolicy);
    },
  );

  app.post<{ Params: PolicyIdParams; Body: EndorsePolicyBody }>(
    "/iam/policies/:id/endorsements",
    { schema: { params: policyIdParamsSchema, body: endorsePolicyBodySchema } },
    async (req, reply) => {
      const result = await endorsePolicy(
        deps.store,
        deps.governanceRoleChecker,
        deps.auditEmitter,
        req.params.id,
        { endorserCitizenId: req.body.endorser_citizen_id, decision: req.body.decision },
      );
      reply.status(201);
      return {
        endorsement: serializeEndorsement(result.endorsement),
        policy: serializePolicy(result.policy),
      };
    },
  );

  app.post<{ Params: PolicyIdParams; Body: RevokePolicyBody }>(
    "/iam/policies/:id/revoke",
    { schema: { params: policyIdParamsSchema, body: revokePolicyBodySchema } },
    async (req) => {
      const policy = await revokePolicy(
        deps.store,
        deps.governanceRoleChecker,
        deps.auditEmitter,
        req.params.id,
        { revokedBy: req.body.revoked_by },
      );
      return serializePolicy(policy);
    },
  );
}
