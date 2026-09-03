# governance-role-service

TypeScript (ADR-019). Manages time-limited governance roles and
multi-approval coordination for critical actions. Spec:
[`.spec/technical/services/srv-011.md`](../../../.spec/technical/services/srv-011.md).
Route prefix `/governance-roles` behind the gateway (ARCH-006). Runs on
port 8080 in-container / 4009 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/governance-role-service dev    # local dev server (tsx watch)
pnpm --filter @dd/governance-role-service test   # vitest
```

Implements, in-memory (no database yet):

- `POST /governance-roles/roles` / `GET /governance-roles/roles` -- create and
  list time-limited governance roles (TBL-032).
- `POST /governance-roles/approvals` -- submit an approval decision on a
  critical action (DP-023). Rejects a role that isn't currently active, a
  citizen with a conflict of interest, a second approval from the same
  citizen on the same `action_ref`, and an approval whose type doesn't
  match the approver role's accountability layer (`citizen_supermajority`
  requires layer `citizen`, `audit_confirmation` requires layer `audit`,
  `body_endorsement` requires layer `protocol` -- ADR-001).
- `GET /governance-roles/actions/:actionRef/status` -- which of the three
  required approval types (`citizen_supermajority`, `audit_confirmation`,
  `body_endorsement`) are satisfied, and whether the action is fully
  approved (DP-035). Re-validates each counted approval's role against the
  current term at read time (ARCH-010 EC-9), so an approval from a role
  whose term has since expired stops counting instead of satisfying its
  type forever.
- `POST /governance-roles/actions/:actionRef/execute` -- protocol-change
  delayed execution (DP-043): requires full approval, `delay_elapsed` and
  `publicly_visible` both true, and gate confirmation; idempotent on repeat
  calls for the same `action_ref`.
- `POST /governance-roles/rotation/sweep` -- daily rotation check (DP-050):
  flags roles whose term ends within 7 days, exactly once per role.

Integrations that don't exist yet as live services in this codebase
(audit-service's protocol-change gate, the actual protocol-change apply
step, and notification/civic-duty-service dispatch from DP-050) are modeled
as small injectable interfaces with no-op/permissive default
implementations -- see `src/collaborators.ts`. `COIChecker` has a real
HTTP-calling implementation (`createHttpCOIChecker`, calling `GET
/competency/conflicts?citizen_id=...`), wired in by `index.ts` whenever
`COMPETENCY_SERVICE_URL` is set, falling back to the permissive default
otherwise, and failing closed (treated as a conflict) on any lookup
failure. Since competency-service's conflict-of-interest records are
domain-scoped but not every consumer's `action_ref` has a domain to check
against (identity-service's suspend/revoke actions, ARCH-010 EC-8, notably
don't), the real implementation checks for *any* declared conflict rather
than one scoped to a specific domain -- see the comment on
`createHttpCOIChecker` for the reasoning. `AuditEmitter` has a real
queue-backed implementation, `createNatsAuditEmitter` (ADR-023): when
`NATS_URL` is set it publishes to the `audit.append` JetStream stream
(`protocol_change.executed` maps to TBL-034's `rule_change`, everything
else -- role creation, approval recording, offboarding flags -- maps to
`admin_action`) instead of doing nothing.
