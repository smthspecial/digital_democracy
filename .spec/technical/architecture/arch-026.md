---
id: ARCH-026
type: arch
title: "Pre-pivot salvage inventory: what commit 33848ae deleted and what's still recoverable"
status: active
linkedIds: EPIC-001,EPIC-002,EPIC-003,EPIC-004,EPIC-005,ADR-027,ADR-028
created: 2026-09-14
---

## Overview

The 2026-09-14 audit of epics 1-5 found that roughly half of the checklisted
capabilities are missing from the current codebase, and flagged a recurring
pattern: several of the "missing" subsystems are not features that were
never built — they were built, in the pre-ADR-027 microservices prototype,
and then dropped wholesale when that prototype was squashed into the
current two-runtime architecture. This document is the inventory that
separates the two cases, so remediation planning sizes each gap correctly
("port a working implementation and its tests" is a materially different
estimate from "design and build a new subsystem") and does not silently
lose track of what already exists in history.

**Verdict, established by git archaeology, not inference:** commit
`33848ae` ("Squashed commit of the following", 2026-09-14) deleted 511
files in one commit, including all four `services/go/*` packages, all
fourteen `services/ts/*` services, and the standalone `testing/e2e-suite`
package. Its parent, `33848ae^` (`79da3ff`), holds the complete pre-pivot
tree. Every path in the tables below was independently verified present at
that commit via `git cat-file -e 33848ae^:<path>` — none is asserted from
memory or from the deleted commit's own messages.

**This is a single systemic event, not five unrelated gaps.** The Sep-8
Prisma migrations (ADR-027/ADR-028) that stood up `apps/api-ts` carried
forward data columns from the pre-pivot schemas, but not the business logic
or tests that used to sit on top of them. Every feature below follows that
same shape: the table exists in `apps/api-ts/prisma/schema.prisma`, the
route/service that used to operate on it does not.

## How to read the tables

- **Recoverable at** — a real path in the tree at `33848ae^`, verified to
  exist (not verified to still be correct against the current schema).
- **Porting effort** — what changes crossing from the pre-pivot shape into
  the current one, because none of this ports as a straight file copy:
  - *Runtime*: Fastify route handlers → NestJS controller + service methods.
  - *Persistence*: an in-memory store (a `Map`, reset on restart) → real
    Prisma calls against Postgres, through `PrismaService`'s
    `forCitizen`/`forWorker` split (ADR-030) — the pre-pivot code has no
    RLS concept at all, because it predates ADR-028's one-database-per-app
    design entirely.
  - *Auth*: the pre-pivot code generally trusts a caller-supplied actor id;
    the current app enforces `@RequiredCitizenId` / `AUTH-010` conditions
    that didn't exist yet when this code was written.
- **Do not port as-is** — specific patterns in the old code that were
  correct for a prototype and are not correct now; each is called out per
  feature rather than once here, because the specifics differ.
- **Capability keys** — the audit's own identifiers (see the epics 1-5
  audit's `data.js`), so a remediation item can cite this doc and a
  specific key in the same sentence.

**Recovery window.** `33848ae^` is a single point of recovery — one
squashed commit ago, not a preserved branch. If history is rewritten
(rebase, `git gc` after a force-push that drops the parent, etc.) this
window closes. Port or extract the material below to a durable branch
sooner rather than treating this document as a permanent index into git
history.

---

## EPIC-001 — Citizen Identity System

| Feature | Recoverable at | Capability keys | Porting effort | Do not port as-is |
|---|---|---|---|---|
| Suspend/revoke endpoints, duplicate-signal scan | `services/ts/identity-service/src/routes/identity.ts`, `src/services/identity.ts`, `src/routes/identity.test.ts` | `revocation-workflow-death`, `revocation-workflow-loss-of-citizenship`, `revocation-workflow-proven-fraud`, `revocation-requires-documented-justification`, `revocation-logged`, `duplicate-identity-signal-review`, `anomalous-creation-pattern-detection` | Runtime + persistence (citizen store is in-memory `Map`, keyed by id). The pre-pivot revoke path calls `notifier`/`audit` seams directly with no approval-gate concept — DP-035's multi-party approval was designed later (ADR-030-era) and has no pre-pivot implementation to port; that gate is new work, not salvage. | The pre-pivot revoke endpoint has no approval-gate check at all — porting it verbatim would ship exactly the unilateral-disable problem the audit flagged (`no-single-role-unilateral-disable`), just relocated. Build the approval gate fresh; port only the state-transition and notification logic underneath it. |
| Cross-service e2e coverage for the identity lifecycle | `services/ts/identity-service/src/e2e/arch010-identity-lifecycle.e2e.test.ts` | (test coverage for the above) | Scenario structure and assertions port; the harness underneath (spawns Fastify processes) needs to become the NestJS-app-boot pattern the current e2e tier uses. | The old harness's service-discovery (fixed pre-pivot ports per `tp-001.md` §0.1) no longer matches the two-runtime topology. |

## EPIC-002 — Sphere of Impact

| Feature | Recoverable at | Capability keys | Porting effort | Do not port as-is |
|---|---|---|---|---|
| Eligibility engine (residency + membership) | `services/ts/jurisdiction-service/src/services/eligibility.ts`, `src/routes/eligibility.ts`, `eligibility.test.ts` | `eligibility-requires-both-residency-and-membership`, `residency-verified-against-proposal-jurisdiction`, `per-proposal-per-jurisdiction-eligibility-evaluation` | Runtime + persistence. Worth close comparison against the current `JurisdictionService.isAffected` (OR semantics) before porting — confirm which one actually implements the epic's AND requirement; do not assume the old code is correct just because it's more complete. | Same caveat as above: verify the old engine's residency/membership boolean logic explicitly rather than porting it on the assumption it already matches FR-012 correctly. |
| Configurable minimum residency period | `services/ts/jurisdiction-service/src/services/eligibility.ts` (same file as above) | `configurable-minimum-residency-period`, `minimum-residency-enforced` | Small — a numeric field plus a comparison. | — |
| Jurisdiction membership + residency management | `services/ts/jurisdiction-service/src/routes/memberships.ts`, `src/routes/residencies.ts` | `simultaneous-nested-jurisdiction-memberships` | Runtime + persistence. | — |
| Scope-assignment and challenge-resolution cycle | `services/ts/jurisdiction-service` routes above, cross-referenced with `services/ts/proposal-service`'s scope fields | `six-level-scope-assignment`, `scope-challenge-tracked-with-status-and-outcome`, `scope-dispute-routed-to-independent-review-body`, `scope-dispute-resolution-is-public` | Runtime + persistence + a real authorization check (AUTH-010's review-body role didn't fully exist pre-pivot either — verify before assuming this is a pure port). | — |

## EPIC-003 — Problem Registry & Proposal Marketplace

| Feature | Recoverable at | Capability keys | Porting effort | Do not port as-is |
|---|---|---|---|---|
| Proposal state machine (DP-029: draft → gathering_support → development → voting) | `services/ts/proposal-service/src/routes/proposals.ts`, `src/services/proposals.ts`, `src/domain/types.ts`, `src/routes/proposals.test.ts` (68 `it(...)` cases in this one file — the audit's "61-test" figure likely also draws on the service-level/integration files; recount precisely when porting rather than reusing either number) | `proposal-advance-gated-by-threshold`, `proposal-threshold-boundary-correctness`, `proposal-enters-development-at-threshold`, `competing-proposals-coexist-in-development`, `development-phase-accepts-alternatives-modifications` | This is the largest single item in this inventory. Runtime + persistence + reconciling with `ADR-030`'s decision to leave `development → voting` gated on constitutional review (SRV-012), which didn't exist as a real service pre-pivot either — the old code's gate for that transition needs the same scrutiny as EPIC-002's eligibility engine above. | The old state machine's `development → voting` transition may itself be a stub (constitutional review not being real pre-pivot either) — read `src/services/proposals.ts`'s handling of that specific transition before assuming it's a complete reference. |
| Population-scaled threshold | `services/ts/proposal-service/src/services/proposals.ts` (same file) | `threshold-scales-with-scope-population` | Depends on jurisdiction population data existing — cross-check against EPIC-002's jurisdiction salvage above; may be co-dependent. | — |
| Constitutional-review gate scenarios (cross-epic, touches EPIC-005's deadlock framework) | `services/ts/proposal-service/src/e2e/arch020-constitutional-review.e2e.test.ts` | (scenario coverage, not a feature) | Scenario structure ports; the gate implementation underneath does not exist pre-pivot either (see above). | — |

## EPIC-004 — Competency & Expertise System

| Feature | Recoverable at | Capability keys | Porting effort | Do not port as-is |
|---|---|---|---|---|
| Expiry/revalidation sweep | `services/ts/competency-service/src/routes/expiry.ts`, `expiry.test.ts` | `competency-expiry-schedule`, `competency-expiry-enforcement`, `inactivity-loses-active-status`, `revalidation-required-to-retain-status` | Runtime + persistence; this was a real `/expiry-sweep` endpoint pre-pivot (callable, not a cron primitive) — the current app has no scheduling infra either, so porting it as a callable endpoint (matching how `apps/api-go`'s `delegation.ExpireDue`/`ActiveDelegations` already handle the same "spec'd async DP, no queue yet" situation) is the right shape, not a new design. | — |

No further EPIC-004 features were found recoverable beyond what's listed
above — the acquisition-pipeline stages (credential verification, domain
review, peer review) do not appear to have had a complete pre-pivot
implementation either; treat those as new work, not salvage, until proven
otherwise by a closer read of `services/ts/competency-service/` than this
inventory pass did.

## EPIC-005 — Public Deliberation & Decision Formation

| Feature | Recoverable at | Capability keys | Porting effort | Do not port as-is |
|---|---|---|---|---|
| Argument locking | `services/ts/deliberation-service/src/routes/deliberation.ts`, `src/services/deliberation.ts`, `src/routes/locking.test.ts` | `argument-lock-marks-settled-fact`, `argument-lock-restricted-to-agreement-stance`, `argument-lock-unknown-id-rejected`, `locked-branch-blocks-new-replies`, `argument-lock-idempotent`, `arguments-listed-sorted-with-lock-state` | Runtime + persistence; needs a `locked` column added to the current `DeliberationArgument` Prisma model (doesn't exist today) before any of this logic has somewhere to write to. | The pre-pivot lock-authorization check needs re-deriving against the current app's `civic_assignment`-based authority model (`type=proposal_review`), which didn't exist in this shape pre-pivot — do not port the old authorization check verbatim. |
| AI synthesis service (entire subsystem, including the safety envelope) | `services/ts/ai-synthesis-service/` in full — `src/services/synthesis.ts`, `src/services/ai-synthesis.ts`, `src/routes/ai-synthesis.ts`, `src/domain/types.ts`, `src/integrations/audit-emitter.ts`, plus four `*.test.ts` files | `ai-synthesis-shared-objectives`, `ai-synthesis-conflict-detection`, `ai-synthesis-generates-alternatives`, `ai-synthesis-estimates-tradeoffs`, `ai-output-mandatory-label`, `ai-output-model-provenance`, `ai-no-governance-write-authority`, `ai-output-human-review-flag`, `ai-synthesis-kill-switch`, `ai-synthesis-auto-trigger-threshold` | Largest single recoverable subsystem in this inventory by file count. This was a complete, independently deployable Fastify service (own `Dockerfile`, `openapi.yaml`, `.env.example`) — porting it means folding it into `apps/api-ts` as a module (per `ADR-031`'s carve-out, it currently has zero footprint there) or deciding it stays a separate concern; that's a decision (see the epics 1-5 remediation plan's decision D31 on where the advisory-output store lives post-pivot), not just an engineering task. | Whatever the pre-pivot code did for "governance write authority isolation" needs re-verification against the current single-database-per-app model (`ADR-028`) — the pre-pivot service had its own separate store by construction; the current architecture does not give that isolation for free. |
| Eight-stage deadlock framework | `services/ts/proposal-service/src/domain/types.ts` (`DeadlockStage`, `DEADLOCK_STAGES`, `DeadlockHistoryEntry`, `DeadlockState` — verified present, all eight stages match FR-034 exactly: `constraint_analysis`, `alternative_generation`, `resource_partitioning`, `compensation_assessment`, `citizen_assembly_review`, `escalation_review`, `constitutional_review`, `final_decision`), with e2e coverage in `src/e2e/arch014-deliberation-synthesis.e2e.test.ts` and `arch020-constitutional-review.e2e.test.ts` | `deadlock-eight-stages-defined-ordered`, `deadlock-entry-from-eligible-status-only`, `deadlock-entry-not-repeatable`, `deadlock-advance-requires-prior-entry`, `deadlock-advance-requires-reviewer-and-notes`, `deadlock-blocks-normal-lifecycle`, `deadlock-resource-partitioning-and-compensation-considered`, `deadlock-final-decision-requires-outcome`, `deadlock-conclusion-sets-proposal-outcome-status`, `deadlock-reviewer-must-be-assigned`, `deadlock-guarantees-terminal-outcome` | Lives in the same file/module as EPIC-003's proposal state machine above — port together, not separately; the deadlock track is a side-track off the same `Proposal` state machine, not an independent feature. | The `constitutional_review` stage depends on the same not-really-implemented-pre-pivot-either gate flagged under EPIC-003 above. |

---

## What this changes about remediation estimates

Four of the five epics have at least one "missing" cluster that is a port,
not a greenfield build: EPIC-001 (revocation, ~7 capabilities),
EPIC-002 (eligibility/residency/challenge, ~8), EPIC-003 (advance/
threshold/development, ~7), EPIC-005 (locking ~6, AI synthesis 10,
deadlock 11). EPIC-004's expiry sweep is a smaller, single-feature port;
its acquisition-pipeline gap does not appear to have pre-pivot source to
draw on and should stay sized as new work.

None of this is a free port. Every feature above crosses from an
in-memory-store, caller-trusted-actor, single-service Fastify prototype
into a Postgres/RLS-backed, `AUTH-010`-enforced NestJS module — the porting
effort column names what specifically has to change, feature by feature,
rather than treating "recoverable" as "done."
