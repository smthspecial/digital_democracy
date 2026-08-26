import type { FastifyInstance } from "fastify";
import { APPROVAL_TYPES } from "../domain/types.js";
import type { ApprovalDecision, ApprovalType } from "../domain/types.js";
import type { Deps } from "../deps.js";
import { serializeActionStatus, serializeApproval, serializeExecutionResult } from "../serializers.js";
import { getActionStatus, submitApproval } from "../services/approvals.js";
import { executeAction } from "../services/execution.js";

interface SubmitApprovalBody {
  action_ref: string;
  approver_role_id: string;
  approval_type: ApprovalType;
  decision: ApprovalDecision;
}

interface ExecuteActionBody {
  delay_elapsed: boolean;
  publicly_visible: boolean;
}

interface ActionRefParams {
  actionRef: string;
}

const submitApprovalBodySchema = {
  type: "object",
  required: ["action_ref", "approver_role_id", "approval_type", "decision"],
  additionalProperties: false,
  properties: {
    action_ref: { type: "string", minLength: 1 },
    approver_role_id: { type: "string", minLength: 1 },
    approval_type: { type: "string", enum: APPROVAL_TYPES },
    decision: { type: "string", enum: ["approved", "rejected"] },
  },
} as const;

const executeActionBodySchema = {
  type: "object",
  required: ["delay_elapsed", "publicly_visible"],
  additionalProperties: false,
  properties: {
    delay_elapsed: { type: "boolean" },
    publicly_visible: { type: "boolean" },
  },
} as const;

const actionRefParamsSchema = {
  type: "object",
  required: ["actionRef"],
  properties: {
    actionRef: { type: "string", minLength: 1 },
  },
} as const;

export function registerApprovalRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: SubmitApprovalBody }>(
    "/governance-roles/approvals",
    { schema: { body: submitApprovalBodySchema } },
    async (req, reply) => {
      const approval = submitApproval(deps.store, deps.coiChecker, deps.auditEmitter, {
        actionRef: req.body.action_ref,
        approverRoleId: req.body.approver_role_id,
        approvalType: req.body.approval_type,
        decision: req.body.decision,
      });
      reply.status(201);
      return serializeApproval(approval);
    },
  );

  app.get<{ Params: ActionRefParams }>(
    "/governance-roles/actions/:actionRef/status",
    { schema: { params: actionRefParamsSchema } },
    async (req) => {
      const status = getActionStatus(deps.store, req.params.actionRef);
      return serializeActionStatus(status);
    },
  );

  app.post<{ Params: ActionRefParams; Body: ExecuteActionBody }>(
    "/governance-roles/actions/:actionRef/execute",
    { schema: { params: actionRefParamsSchema, body: executeActionBodySchema } },
    async (req) => {
      const result = executeAction(
        deps.store,
        deps.protocolGateChecker,
        deps.protocolChangeExecutor,
        deps.auditEmitter,
        req.params.actionRef,
        { delayElapsed: req.body.delay_elapsed, publiclyVisible: req.body.publicly_visible },
      );
      return serializeExecutionResult(result);
    },
  );
}
