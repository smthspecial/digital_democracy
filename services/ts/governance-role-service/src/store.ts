import { randomUUID } from "node:crypto";
import type {
  Approval,
  ApprovalDecision,
  ApprovalType,
  GovernanceRole,
  Layer,
  RoleType,
} from "./domain/types.js";

export interface CreateRoleInput {
  citizenId: string;
  roleType: RoleType;
  layer: Layer;
  randomized: boolean;
  termStart: Date;
  termEnd: Date;
}

export interface RoleFilter {
  citizenId?: string;
  roleType?: RoleType;
}

export interface CreateApprovalInput {
  actionRef: string;
  approverRoleId: string;
  approvalType: ApprovalType;
  decision: ApprovalDecision;
}

export interface ExecutionRecord {
  actionRef: string;
  executedAt: Date;
  delayElapsed: boolean;
  publiclyVisible: boolean;
}

export function createStore() {
  const roles = new Map<string, GovernanceRole>();
  const approvals = new Map<string, Approval>();
  const executions = new Map<string, ExecutionRecord>();

  return {
    createRole(input: CreateRoleInput): GovernanceRole {
      const role: GovernanceRole = {
        id: randomUUID(),
        citizenId: input.citizenId,
        roleType: input.roleType,
        layer: input.layer,
        termStart: input.termStart,
        termEnd: input.termEnd,
        randomized: input.randomized,
        offboardingNotified: false,
      };
      roles.set(role.id, role);
      return role;
    },

    getRole(id: string): GovernanceRole | undefined {
      return roles.get(id);
    },

    listRoles(filter: RoleFilter = {}): GovernanceRole[] {
      return [...roles.values()].filter(
        (role) =>
          (filter.citizenId === undefined || role.citizenId === filter.citizenId) &&
          (filter.roleType === undefined || role.roleType === filter.roleType),
      );
    },

    flagOffboarding(id: string): GovernanceRole {
      const role = roles.get(id);
      if (!role) {
        throw new Error(`cannot flag unknown role ${id}`);
      }
      const flagged: GovernanceRole = { ...role, offboardingNotified: true };
      roles.set(id, flagged);
      return flagged;
    },

    createApproval(input: CreateApprovalInput): Approval {
      const approval: Approval = {
        id: randomUUID(),
        actionRef: input.actionRef,
        approverRoleId: input.approverRoleId,
        approvalType: input.approvalType,
        decision: input.decision,
        createdAt: new Date(),
      };
      approvals.set(approval.id, approval);
      return approval;
    },

    listApprovalsForAction(actionRef: string): Approval[] {
      return [...approvals.values()].filter((approval) => approval.actionRef === actionRef);
    },

    getExecution(actionRef: string): ExecutionRecord | undefined {
      return executions.get(actionRef);
    },

    setExecution(record: ExecutionRecord): void {
      executions.set(record.actionRef, record);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
