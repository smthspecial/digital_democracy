import type { FastifyInstance } from "fastify";
import { ENDORSEMENT_DECISIONS } from "../domain/types.js";
import type { EndorsementDecision } from "../domain/types.js";
import type { Deps } from "../deps.js";
import { serializeAttachment, serializeEndorsement } from "../serializers.js";
import {
  endorseAttachment,
  listAttachments,
  proposeAttachment,
  revokeAttachment,
} from "../services/attachments.js";

interface ProposeAttachmentBody {
  policy_id: string;
  principal_ref: string;
  proposed_by: string;
}

interface ListAttachmentsQuery {
  principal_ref?: string;
}

interface EndorseAttachmentBody {
  endorser_citizen_id: string;
  decision: EndorsementDecision;
}

interface RevokeAttachmentBody {
  revoked_by: string;
}

interface AttachmentIdParams {
  id: string;
}

const proposeAttachmentBodySchema = {
  type: "object",
  required: ["policy_id", "principal_ref", "proposed_by"],
  additionalProperties: false,
  properties: {
    policy_id: { type: "string", minLength: 1 },
    principal_ref: { type: "string", minLength: 1 },
    proposed_by: { type: "string", minLength: 1 },
  },
} as const;

const listAttachmentsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    principal_ref: { type: "string" },
  },
} as const;

const endorseAttachmentBodySchema = {
  type: "object",
  required: ["endorser_citizen_id", "decision"],
  additionalProperties: false,
  properties: {
    endorser_citizen_id: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ENDORSEMENT_DECISIONS },
  },
} as const;

const revokeAttachmentBodySchema = {
  type: "object",
  required: ["revoked_by"],
  additionalProperties: false,
  properties: {
    revoked_by: { type: "string", minLength: 1 },
  },
} as const;

const attachmentIdParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
  },
} as const;

// DP-069/070/072 over TBL-041, via services/attachments.ts -- identical
// route<->service split as routes/policies.ts.
export function registerAttachmentRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: ProposeAttachmentBody }>(
    "/iam/attachments",
    { schema: { body: proposeAttachmentBodySchema } },
    async (req, reply) => {
      const attachment = await proposeAttachment(
        deps.store,
        deps.governanceRoleChecker,
        deps.auditEmitter,
        {
          policyId: req.body.policy_id,
          principalRef: req.body.principal_ref,
          proposedBy: req.body.proposed_by,
        },
      );
      reply.status(201);
      return serializeAttachment(attachment);
    },
  );

  app.get<{ Querystring: ListAttachmentsQuery }>(
    "/iam/attachments",
    { schema: { querystring: listAttachmentsQuerySchema } },
    async (req) => {
      const attachments = listAttachments(deps.store, { principalRef: req.query.principal_ref });
      return attachments.map(serializeAttachment);
    },
  );

  app.post<{ Params: AttachmentIdParams; Body: EndorseAttachmentBody }>(
    "/iam/attachments/:id/endorsements",
    { schema: { params: attachmentIdParamsSchema, body: endorseAttachmentBodySchema } },
    async (req, reply) => {
      const result = await endorseAttachment(
        deps.store,
        deps.governanceRoleChecker,
        deps.auditEmitter,
        req.params.id,
        { endorserCitizenId: req.body.endorser_citizen_id, decision: req.body.decision },
      );
      reply.status(201);
      return {
        endorsement: serializeEndorsement(result.endorsement),
        attachment: serializeAttachment(result.attachment),
      };
    },
  );

  app.post<{ Params: AttachmentIdParams; Body: RevokeAttachmentBody }>(
    "/iam/attachments/:id/revoke",
    { schema: { params: attachmentIdParamsSchema, body: revokeAttachmentBodySchema } },
    async (req) => {
      const attachment = await revokeAttachment(
        deps.store,
        deps.governanceRoleChecker,
        deps.auditEmitter,
        req.params.id,
        { revokedBy: req.body.revoked_by },
      );
      return serializeAttachment(attachment);
    },
  );
}
