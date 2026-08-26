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
  citizen with a conflict of interest, and a second approval from the same
  citizen on the same `action_ref`.
- `GET /governance-roles/actions/:actionRef/status` -- which of the three
  required approval types (`citizen_supermajority`, `audit_confirmation`,
  `body_endorsement`) are satisfied, and whether the action is fully
  approved (DP-035).
- `POST /governance-roles/actions/:actionRef/execute` -- protocol-change
  delayed execution (DP-043): requires full approval, `delay_elapsed` and
  `publicly_visible` both true, and gate confirmation; idempotent on repeat
  calls for the same `action_ref`.
- `POST /governance-roles/rotation/sweep` -- daily rotation check (DP-050):
  flags roles whose term ends within 7 days, exactly once per role.

Integrations that don't exist yet as live services in this codebase
(audit-service's protocol-change gate, competency-service's COI signal, the
actual protocol-change apply step, and notification/civic-duty-service
dispatch from DP-050) are modeled as small injectable interfaces with
no-op/permissive default implementations -- see `src/collaborators.ts`.
