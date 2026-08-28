# competency-service

TypeScript (ADR-019). Owns domain competency applications,
conflict-of-interest declarations, and competency challenges. Spec:
[`.spec/technical/services/srv-005.md`](../../../.spec/technical/services/srv-005.md).
Route prefix `/competency` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4005 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/competency-service dev    # local dev server (tsx watch)
pnpm --filter @dd/competency-service test   # vitest
```

In addition to the health contract (`/healthz`, `/readyz`), the in-memory
five-stage competency pipeline (DP-011/DP-031), conflict-of-interest
declarations with auto-exclusion (DP-010/DP-033), advisory expert
assessments (DP-021), competency challenges (DP-012/DP-032), and the
expiry sweep (DP-044) are implemented under the `/competency` prefix --
see `openapi.yaml` for the full contract. Persistence is in-memory only
(no database yet); cross-service effects (auto-exclusion enforcement,
expiry notifications) are modeled as injectable seams with no-op
defaults (`src/integrations.ts`).

Two events credit reputation-service (DP-038, FR-027): declaring a
conflict of interest emits a positive `disclosure` delta, and an upheld
challenge emits a negative delta (mapped from the challenge's `reason` --
`conflict`→`undisclosed_conflict`, `false_claim`→`misinformation`,
`misconduct`→`manipulation`, `credentials`→`fraud`) against the
competency holder, not the challenger. `ReputationEmitter` has a real
HTTP-calling implementation (`createHttpReputationEmitter`), wired in by
`index.ts` when `REPUTATION_SERVICE_URL` is set, falling back to a no-op
otherwise.
