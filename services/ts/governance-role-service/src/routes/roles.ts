import type { FastifyInstance } from "fastify";
import { LAYERS, ROLE_TYPES } from "../domain/types.js";
import type { Layer, RoleType } from "../domain/types.js";
import type { Deps } from "../deps.js";
import { serializeRole } from "../serializers.js";
import { createRole, listRoles } from "../services/roles.js";

interface CreateRoleBody {
  citizen_id: string;
  role_type: RoleType;
  layer: Layer;
  randomized: boolean;
  term_start: string;
  term_end: string;
}

interface ListRolesQuery {
  citizen_id?: string;
  role_type?: RoleType;
}

const createRoleBodySchema = {
  type: "object",
  required: ["citizen_id", "role_type", "layer", "randomized", "term_start", "term_end"],
  additionalProperties: false,
  properties: {
    citizen_id: { type: "string", minLength: 1 },
    role_type: { type: "string", enum: ROLE_TYPES },
    layer: { type: "string", enum: LAYERS },
    randomized: { type: "boolean" },
    term_start: { type: "string", format: "date-time" },
    term_end: { type: "string", format: "date-time" },
  },
} as const;

const listRolesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    citizen_id: { type: "string" },
    role_type: { type: "string", enum: ROLE_TYPES },
  },
} as const;

export function registerRoleRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: CreateRoleBody }>(
    "/governance-roles/roles",
    { schema: { body: createRoleBodySchema } },
    async (req, reply) => {
      const role = createRole(deps.store, deps.auditEmitter, {
        citizenId: req.body.citizen_id,
        roleType: req.body.role_type,
        layer: req.body.layer,
        randomized: req.body.randomized,
        termStart: new Date(req.body.term_start),
        termEnd: new Date(req.body.term_end),
      });
      reply.status(201);
      return serializeRole(role);
    },
  );

  app.get<{ Querystring: ListRolesQuery }>(
    "/governance-roles/roles",
    { schema: { querystring: listRolesQuerySchema } },
    async (req) => {
      const roles = listRoles(deps.store, {
        citizenId: req.query.citizen_id,
        roleType: req.query.role_type,
      });
      return roles.map(serializeRole);
    },
  );
}
