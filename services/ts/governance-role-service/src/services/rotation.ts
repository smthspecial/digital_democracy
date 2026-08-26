import type { AuditEmitter, NotificationEmitter, ReplacementRequester } from "../collaborators.js";
import type { GovernanceRole } from "../domain/types.js";
import type { Store } from "../store.js";

const OFFBOARDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RotationSweepResult {
  flagged: GovernanceRole[];
}

export function sweepRotation(
  store: Store,
  notificationEmitter: NotificationEmitter,
  replacementRequester: ReplacementRequester,
  auditEmitter: AuditEmitter,
  now: Date = new Date(),
): RotationSweepResult {
  const threshold = now.getTime() + OFFBOARDING_WINDOW_MS;
  const flagged: GovernanceRole[] = [];

  for (const role of store.listRoles({})) {
    if (role.offboardingNotified || role.termEnd.getTime() >= threshold) {
      continue;
    }

    const updated = store.flagOffboarding(role.id);
    notificationEmitter.notify(updated.id, "governance role term ending within 7 days");
    replacementRequester.requestReplacement(updated.id);
    auditEmitter.emit("governance_role.offboarding_flagged", { roleId: updated.id });
    flagged.push(updated);
  }

  return { flagged };
}
