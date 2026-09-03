import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { serializeEvaluateResult } from "../serializers.js";
import { evaluateAccess } from "../services/evaluate.js";

interface EvaluateAccessBody {
  principal_ref: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}

const evaluateAccessBodySchema = {
  type: "object",
  required: ["principal_ref", "action", "resource"],
  additionalProperties: false,
  properties: {
    principal_ref: { type: "string", minLength: 1 },
    action: { type: "string", minLength: 1 },
    resource: { type: "string", minLength: 1 },
    context: { type: "object" },
  },
} as const;

// DP-071/ARCH-024 §4: the read-only evaluation entrypoint. Deliberately not
// audited (see services/evaluate.ts's own top-of-file note) -- no
// auditEmitter used here at all.
export function registerEvaluateRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: EvaluateAccessBody }>(
    "/iam/evaluate",
    { schema: { body: evaluateAccessBodySchema } },
    async (req) => {
      const result = await evaluateAccess(deps.store, deps.governanceRoleChecker, {
        principalRef: req.body.principal_ref,
        action: req.body.action,
        resource: req.body.resource,
        context: req.body.context,
      });
      return serializeEvaluateResult(result);
    },
  );
}
