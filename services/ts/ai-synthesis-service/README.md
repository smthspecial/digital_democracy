# ai-synthesis-service

TypeScript (ADR-019). Owns AI-assisted deliberation synthesis; advisory
and non-authoritative only. Spec: [`.spec/technical/services/srv-016.md`](../../../.spec/technical/services/srv-016.md).
Route prefix `/ai-synthesis` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4013 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/ai-synthesis-service dev    # local dev server (tsx watch)
pnpm --filter @dd/ai-synthesis-service test   # vitest
```

Implements DP-037 (AI policy synthesis) in-memory:

- `POST /ai-synthesis/synthesize` -- runs the rule-based synthesis algorithm
  over an explicit `{ proposal_id, arguments, preferences }` body (there is
  no live read from `deliberation-service` yet, so the caller supplies the
  data directly) and stores/returns the labeled `SynthesisOutput`. Returns
  `{ disabled: true }` without storing anything while the service is
  disabled.
- `POST /ai-synthesis/toggle` -- protocol-layer enable/disable switch.
- `POST /ai-synthesis/outputs/:id/flag` -- any citizen may flag an output as
  biased/misleading; reasons accumulate, `flagged` becomes `true`.
- `GET /ai-synthesis/outputs/:id`, `GET /ai-synthesis/proposals/:proposalId/outputs` -- reads.

Every returned output carries the mandatory, non-removable label
`"AI-generated analysis — advisory only, subject to human review."` and a
hardcoded model-provenance block (there is no real model in this phase).
The service has no write access to any governance table -- outputs live
only in this service's own in-memory advisory store.

Each synthesis run emits an `AuditEmitter` event (DP-036), no-op by
default. `AuditEmitter` has a real queue-backed implementation,
`createNatsAuditEmitter` (ADR-023): when `NATS_URL` is set it publishes to
the `audit.append` JetStream stream instead of doing nothing
(`ai_synthesis.executed` has no dedicated TBL-034 bucket, so it maps to
`system_update`).
