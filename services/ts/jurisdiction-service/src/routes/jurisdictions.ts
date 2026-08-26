import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { SCOPE_LEVELS, type ScopeLevel } from "../domain/types.js";
import { changeScopeLevel, createJurisdiction, getJurisdictionTree } from "../services/jurisdictions.js";

interface CreateJurisdictionBody {
  parent_id?: string | null;
  name: string;
  scope_level: ScopeLevel;
  boundary_ref: string;
}

interface ScopeLevelBody {
  scope_level: ScopeLevel;
}

interface IdParams {
  id: string;
}

export function registerJurisdictionRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: CreateJurisdictionBody }>(
    "/jurisdiction/jurisdictions",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "scope_level", "boundary_ref"],
          properties: {
            parent_id: { type: ["string", "null"] },
            name: { type: "string", minLength: 1 },
            scope_level: { type: "string", enum: SCOPE_LEVELS },
            boundary_ref: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const jurisdiction = createJurisdiction(deps.store, deps.auditEmitter, {
        parent_id: request.body.parent_id ?? null,
        name: request.body.name,
        scope_level: request.body.scope_level,
        boundary_ref: request.body.boundary_ref,
      });
      reply.status(201).send(jurisdiction);
    },
  );

  app.get<{ Params: IdParams }>(
    "/jurisdiction/jurisdictions/:id/tree",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (request) => getJurisdictionTree(deps.store, request.params.id),
  );

  app.post<{ Params: IdParams; Body: ScopeLevelBody }>(
    "/jurisdiction/jurisdictions/:id/scope-level",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["scope_level"],
          properties: { scope_level: { type: "string", enum: SCOPE_LEVELS } },
          additionalProperties: false,
        },
      },
    },
    async (request) =>
      changeScopeLevel(
        deps.store,
        deps.approvalGate,
        deps.auditEmitter,
        request.params.id,
        request.body.scope_level,
      ),
  );
}
