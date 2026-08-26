# deliberation-service

TypeScript (ADR-019). Owns deliberation arguments and preference
declarations, and triggers AI-assisted synthesis. Spec:
[`.spec/technical/services/srv-006.md`](../../../.spec/technical/services/srv-006.md).
Route prefix `/deliberation` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4006 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/deliberation-service dev    # local dev server (tsx watch)
pnpm --filter @dd/deliberation-service test   # vitest
```

## Implemented

- `POST /deliberation/arguments` -- post a threaded, evidence-linked argument
  (DP-008). `evidence_ref` and `stance` (`agreement` | `disagreement`) are
  required; a submission without `evidence_ref` is rejected with 400.
  `parent_id` threads a reply under an existing argument.
- `POST /deliberation/arguments/:id/lock` -- lock an `agreement`-stance
  argument's branch to prevent re-litigation of an established fact; locking
  a `disagreement`-stance argument is rejected with 400. Once locked, any
  reply anywhere in that argument's subtree is rejected with 409.
- `GET /deliberation/proposals/:proposalId/arguments` -- flat list of a
  proposal's arguments (including `parent_id`), sorted by `created_at`;
  clients reconstruct the reply tree client-side.
- `POST /deliberation/preferences` -- declare a citizen's desired outcome for
  a problem (DP-009), captured before proposals exist -- tied to
  `problem_id`, not a proposal.
- `GET /deliberation/problems/:problemId/preferences` -- list a problem's
  declared preferences, sorted by `created_at`.

DP-037 (AI policy synthesis, SRV-016) and DP-036 (audit log append,
SRV-012) are modeled as injectable no-op collaborators (`SynthesisTrigger`,
`AuditEmitter`) since those services don't exist in this codebase yet --
see `src/collaborators.ts`. The synthesis trigger fires once per
configurable threshold of new arguments/preferences crossed (default 5),
tracked per `proposal_id` for arguments and per `problem_id` for
preferences.

Storage is in-memory only (`src/store.ts`), behind the same seam a real
persistence layer will sit behind later.
