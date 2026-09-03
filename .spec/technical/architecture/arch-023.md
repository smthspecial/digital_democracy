---
id: ARCH-023
type: arch
title: "PostgreSQL row-level security and DB-level consistency pattern, per service database"
status: active
created: 2026-09-02
---

## Overview

This document is the concrete technical pattern realizing ADR-024. It gives every service's migration the same shape: two Postgres roles, two session GUCs, a small set of row-security-policy templates keyed to AUTH-010's scope types, and a full per-table classification so no service has to re-derive the model from scratch. ARCH-006 §5 already established *that* each of the 17 services owns exactly one Postgres cluster; this document defines what runs inside each of those clusters.

No migration tooling is mandated by name (none exists in this repo yet — ADR-024 §Consequences). Files are plain, tool-agnostic numbered SQL, compatible with golang-migrate, node-pg-migrate, Flyway, or a hand-rolled runner, whichever gets chosen when a service is actually wired to Postgres.

---

## 1. Migration file layout

Per service: `services/<go|ts>/<service-name>/db/migrations/0001_init.up.sql` and `0001_init.down.sql`. `0001_init` creates every table the service owns (per its `srv-NNN.md` `tables:` field), its two roles, and all policies in one migration — there is no existing schema to evolve incrementally from. Later schema changes get their own numbered pair; this document does not define a "current" schema beyond the fields the `tbl-NNN.md` docs already specify.

`notification-service` (SRV-015) and `ai-synthesis-service` (SRV-016) own no tables per their `srv-NNN.md` and are out of scope for this pass.

---

## 2. Roles

Every service creates exactly two roles in its own database (safe — ARCH-006 §5: 17 separate Postgres clusters, no name collision risk):

- **`<svc>_app`** — the role the service's normal request-serving connection pool authenticates as. `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`. Subject to every RLS policy without exception (`FORCE ROW LEVEL SECURITY`, §3). This is the *only* role that ever serves a directly citizen-authenticated HTTP request.
- **`<svc>_worker`** — the role used for (a) this service's own internal async/cron jobs (the "System-only permissions" table in AUTH-010 — DP-002, DP-025, DP-027, DP-040, DP-050, DP-043, etc.), and (b) the HTTP handlers that serve *other* services' peer reads/writes (the "Dependencies" section of each `srv-NNN.md`). `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS` — deliberately not `BYPASSRLS`; it gets its own, broader policies (§3) rather than an unconditional bypass, so `pg_policies` stays the single readable source of truth for what every role can touch, and a future audit never has to reason about an invisible bypass flag.

`<svc>` is the service's short slug (e.g. `identity`, `voting`, `governance_role`, `budget`).

Neither role is ever granted `DELETE` on any table in this pass — nothing in the `tbl-NNN.md` set is meant to be hard-deleted; status/lifecycle columns record the end state instead. If a future table genuinely needs deletion (e.g. a true draft never submitted), grant it explicitly on that table rather than widening the default.

---

## 3. Session context

The application sets two GUCs with `SET LOCAL` at the start of every transaction on an `<svc>_app` connection, resolved from the session/JWT the citizen already authenticated with (auth-service, ADR-014) — never trusted from a request body:

- `app.citizen_id` — the acting citizen's `uuid`, or unset/empty for an unauthenticated request (e.g. `ballot:verify`, `identity:register`).
- `app.actor_role` — reserved for later use (e.g. distinguishing an operator-organizational credential from a citizen one within the same `_app` role); no policy in this pass keys off it yet, but every service defines the helper function so adding such a policy later doesn't require touching existing ones.

Every migration defines a local helper so policies stay short and it's obvious at a glance which predicate is doing the ownership check:

```sql
CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;
```

`<svc>_worker` connections never set `app.citizen_id` — its policies (§4.3) don't key off it.

---

## 4. Policy templates

Every table gets `ALTER TABLE t ENABLE ROW LEVEL SECURITY; ALTER TABLE t FORCE ROW LEVEL SECURITY;` — no exceptions, including tables that end up fully public-readable (an explicit `USING (true)` policy is still a policy; the point is that *no* row is ever visible or writable without one).

### 4.1 `OWN` — citizen-private rows

Used where AUTH-010 grants scope `own` and the owning column is in this table (or a same-database parent, e.g. `proposal:author` — see EC below). Read and write both restricted to the owner; the worker role gets its own separate, broader policy (§4.3) rather than the owner policy trying to cover both.

```sql
CREATE POLICY t_own_select ON t FOR SELECT TO <svc>_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY t_own_insert ON t FOR INSERT TO <svc>_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY t_own_update ON t FOR UPDATE TO <svc>_app
  USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());
```

Variant — **local parent ownership** (`proposal:author`, `domain:match` against a same-database sibling table): replace the bare column check with an `EXISTS` against the parent/sibling row, e.g. for `proposal_constraint` (proposal-service owns both `proposal` and `proposal_constraint`):

```sql
WITH CHECK (EXISTS (SELECT 1 FROM proposal p WHERE p.id = proposal_id AND p.author_id = current_citizen_id()))
```

### 4.2 `PUBLIC` — governance-transparent rows

Used where AUTH-010 documents the read as `any`/public (`governance_data:read`, `audit_log:read`, the real-time ledger, etc.) — the anti-corruption principle in CON-005 ("no hidden budgets, no closed deliberation") makes broad readability the default for governance content, not the exception.

```sql
CREATE POLICY t_public_read ON t FOR SELECT TO <svc>_app, <svc>_worker
  USING (true);
```
Paired with an `OWN`-style or worker-only write policy depending on who is allowed to author rows (see the classification table, §6, per table).

### 4.3 Worker policy (every table)

Every table additionally gets one blanket policy for `<svc>_worker`:

```sql
CREATE POLICY t_worker_all ON t FOR ALL TO <svc>_worker
  USING (true) WITH CHECK (true);
```

This is deliberate, not a loophole: `<svc>_worker` only ever serves (a) code paths this document's §2 already restricts to internal DP-jobs/cron, and (b) peer-service HTTP handlers that have already authorized the request via that handler's own logic plus the mesh's mTLS workload-identity check (ADR-018, AUTH-012) before ever opening a transaction. RLS's job for this role is bookkeeping-consistency (still going through named policies, still visible in `pg_policies`), not authorization — authorization for this path already happened one layer up, the same way it does for every existing HTTP integration seam in this codebase today (e.g. `httpIdentityChecker`, `createHttpJurisdictionClient`).

### 4.4 `APPEND_ONLY` — immutable history

Used for `audit_log`, `ballot`, `ledger_entry`, and any table where a row, once written, must never change (governance-critical per ADR-017's RTO/RPO tiering). No role — not even `<svc>_worker` — is granted `UPDATE` or `DELETE`:

```sql
REVOKE UPDATE, DELETE ON t FROM <svc>_app, <svc>_worker;

CREATE OR REPLACE FUNCTION t_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 't is append-only: % not permitted', TG_OP;
END;
$$;
CREATE TRIGGER t_no_update BEFORE UPDATE ON t
  FOR EACH ROW EXECUTE FUNCTION t_forbid_mutation();
CREATE TRIGGER t_no_delete BEFORE DELETE ON t
  FOR EACH ROW EXECUTE FUNCTION t_forbid_mutation();
```

The trigger is deliberate belt-and-suspenders beyond the `REVOKE`: it also stops the table owner / migrator role (which is never subject to `REVOKE`d grants on its own objects) from mutating history by accident during a future manual migration.

`audit_log` additionally gets a hash-chain integrity trigger. `created_at` (a timestamp) cannot give a strict, gapless total order under concurrent inserts, so the migration adds an internal `seq bigserial` column (not in TBL-034's documented column list — a DB-level ordering mechanism, not a business field) and a `BEFORE INSERT` trigger requiring `NEW.prev_hash` to equal the `payload_hash` of the row with `seq = (SELECT max(seq) FROM audit_log)` (or a fixed genesis value on the first row).

### 4.5 `SPECIAL` — ballot / eligibility_token (voting-service)

The one place this pattern deliberately breaks its own rules, because ADR-002/NFR-001 outrank it:

- **`eligibility_token`** has `citizen_id` and gets the `OWN` read policy (a citizen may confirm they hold a token and whether it's `used`) — but **no `OWN` write policy at all**. Only `<svc>_worker` may `INSERT` (DP-025 batch-issue) or `UPDATE` the `used` flag. The HTTP handler for `POST /vote-sessions/:id/ballots` (ballot casting) must run its `used = true` flip and the paired `ballot` insert in one transaction under `<svc>_worker`, not `<svc>_app` — this is the single-writer, one-token-one-ballot invariant (`token.unused` condition, AUTH-010), and it is precisely the kind of system-invariant-not-CRUD operation §2 carves the worker role out for.
- **`ballot`** has no `citizen_id` column, full stop — no policy here may ever introduce one or join it back to `eligibility_token`/`citizen` (TBL-022's own notes: "DELIBERATELY has no citizen_id"). It gets `PUBLIC` read (verifiable voting means the encrypted, unlinkable ballot set is meant to be publicly auditable — `ballot:verify` in AUTH-010 is explicitly `unauthenticated`, scope `any`), `<svc>_worker`-only insert, and the full `APPEND_ONLY` treatment (§4.4) — a cast ballot is never edited or removed.

---

## 5. The cross-service scope limitation (read this before writing any policy)

ADR-015's database-per-service boundary means an RLS policy in one service's database can **never** reference another service's tables — there is no cross-database join available (no FDW is wired up, and wiring one would quietly reopen the isolation ADR-015 exists to close). Several of AUTH-010's scope types are inherently cross-service relative to where they'd need to be checked:

| Scope type | Needs data from | Same DB as the resource? |
|---|---|---|
| `own` | the resource's own table | always yes |
| `proposal:author` | `proposal` (proposal-service) | yes, when the resource is also proposal-service's (constraint/budget) |
| `domain:match` | `competency` (competency-service) | yes, when the resource is also competency-service's (`expert_assessment`) |
| `session:issued` | `eligibility_token` (voting-service) | yes, when the resource is `ballot` (also voting-service) |
| `jurisdiction:member` / `jurisdiction:affected` | `jurisdiction_membership`/`residency` (jurisdiction-service) | **no**, whenever the resource lives in another service (proposal, problem, …) |
| `assigned` | `civic_assignment` (civic-duty-service) | **no**, whenever the resource lives in another service (project, audit, …) |

Where the "same DB?" column is yes, the policy does the real check itself (§4.1's `EXISTS` variant, or the `expert_assessment` competency-domain check). Where it's no, RLS in the resource's own database cannot verify the scope — the calling service must resolve it itself, exactly the way this codebase already does for every cross-service authorization gap ARCH-010/011/012 document (`createHttpJurisdictionClient`, `createHttpApprovalGate`, `createHttpCOIChecker`): the HTTP handler checks eligibility over the wire *before* opening its own database transaction, then performs the already-authorized write under `<svc>_worker`. RLS is not, and cannot be, a substitute for that seam — it is the second layer behind it for everything checkable locally, and it is honest about not covering what isn't. Document any table whose write depends on an unresolved cross-service seam (mirroring the "blocked on: X" style ARCH-010/011/012 already use) rather than faking a local check that doesn't actually verify the real condition.

Conditions requiring runtime business-rule evaluation that isn't a row-visibility question at all — `coi.none`, `evidence.required`, `totals:100`, `dual_control`, `role.term` cross-checked against wall-clock `now()` at read time — stay in application code as they are today (AUTH-009 §Enforcement contract). RLS is scoped to row ownership and public/private visibility; it is a second layer behind, not a replacement for, full AUTH-009/010 enforcement.

---

## 6. Per-table classification

`relations:`/`owned_by:` below are drawn from each `tbl-NNN.md`'s front matter, so a migration author isn't re-deriving foreign keys from prose. FKs are enforced only within the same service database (§5); a cross-service reference is documented in a comment, not an FK.

| Table (owner service) | Class | Key predicate / note |
|---|---|---|
| TBL-001 citizen (identity) | OWN | `id = current_citizen_id()`; `_app` INSERT unconditional (self-registration, DP-001, unauthenticated) |
| TBL-002 identity_verification (identity) | OWN | `citizen_id` |
| TBL-003 jurisdiction (jurisdiction) | PUBLIC | read any; write `_worker` only (administrative) |
| TBL-004 residency (jurisdiction) | OWN | `citizen_id` |
| TBL-005 jurisdiction_membership (jurisdiction) | OWN | `citizen_id` |
| TBL-006 problem (problem) | PUBLIC | read any; `_app` INSERT any active citizen (`submitted_by = current_citizen_id()` on insert) |
| TBL-007 problem_support (problem) | PUBLIC read + OWN insert | `citizen_id`; `UNIQUE (problem_id, citizen_id)` |
| TBL-008 proposal (proposal) | PUBLIC read + OWN write | `author_id = current_citizen_id()` for update; any active citizen may insert (becomes author) |
| TBL-009 proposal_constraint (proposal) | PUBLIC read + local-parent OWN write | §4.1 `EXISTS` against `proposal.author_id` |
| TBL-010 proposal_budget (proposal) | PUBLIC read + local-parent OWN write | §4.1 `EXISTS` against `proposal.author_id` |
| TBL-011 expert_domain (competency) | PUBLIC | reference data; `_worker`-managed |
| TBL-012 competency (competency) | PUBLIC read + OWN write | `citizen_id` |
| TBL-013 competency_challenge (competency) | PUBLIC read + authenticated insert | any active citizen (not owner-scoped — targets another citizen's competency) |
| TBL-014 conflict_of_interest (competency) | OWN | `citizen_id`, self-disclosure only |
| TBL-015 expert_assessment (competency) | PUBLIC read + local domain-match write | §4.1 variant against `competency.citizen_id/domain/status='active'` |
| TBL-016 reputation_record (reputation) | PUBLIC read | `_worker`-only write (system-computed) |
| TBL-017 deliberation_argument (deliberation) | PUBLIC | read any; `_app` INSERT any active citizen |
| TBL-018 preference (deliberation) | PUBLIC read + OWN insert | `citizen_id`; `UNIQUE (proposal_id, citizen_id)` |
| TBL-019 vote_session (voting) | PUBLIC | read any; write `_worker` only (DP-025/DP-027) |
| TBL-020 vote_option (voting) | PUBLIC | read any; write `_worker` only |
| TBL-021 eligibility_token (voting) | SPECIAL (§4.5) | OWN read only; `_worker`-only write |
| TBL-022 ballot (voting) | SPECIAL (§4.5) + APPEND_ONLY | no citizen_id, ever; PUBLIC read; `_worker`-only insert |
| TBL-023 delegation (delegation) | PUBLIC read + OWN write | SRV-010 Key rules/FR-056: "delegator, delegate, domain, and period are readable by any citizen" — public read, writes (insert/revoke) restricted to `delegator_id = current_citizen_id()` |
| TBL-024 civic_assignment (civic-duty) | OWN | assigned citizen only (`assigned` scope, locally resolvable — same DB) |
| TBL-025 participation_record (civic-duty) | OWN | private participation history (CON-005 layer 1) |
| TBL-026 budget_category (budget) | PUBLIC | reference data; `_worker`-managed |
| TBL-027 budget_allocation_vote (budget) | OWN | `citizen_id`; treated as vote-adjacent, defaults private like a ballot rather than public |
| TBL-028 ledger_entry (budget) | PUBLIC + APPEND_ONLY | FR-036 public ledger; `_worker`-only insert (AUTH-006 operator) |
| TBL-029 project (project) | PUBLIC | oversight layer is public by design |
| TBL-030 project_milestone (project) | PUBLIC read + worker write | `assigned` scope is cross-service (civic-duty) — §5; write via `_worker` only, after the app resolves the assignment check over HTTP |
| TBL-031 outcome_evaluation (project) | PUBLIC read + worker write | same cross-service note as milestone |
| TBL-032 governance_role (governance-role) | PUBLIC | transparency of role/term; write `_worker` only |
| TBL-033 approval (governance-role) | PUBLIC read + OWN insert | `approver_id = current_citizen_id()`; same-DB `EXISTS` against `governance_role` for term/type is a natural strengthening — implement if the table's actual columns support it |
| TBL-034 audit_log (audit) | PUBLIC + APPEND_ONLY (§4.4, hash chain) | `audit_log:read` is T1-public; `_worker`-only insert |
| TBL-035 constitutional_right (audit) | PUBLIC | registry; `_worker`-only write |
| TBL-036 constitutional_review (audit) | PUBLIC read + worker write | reviewing role is governance-role-service's `governance_role` — cross-service (§5); write via `_worker` |
| TBL-037 session (auth) | OWN | `citizen_id`; `_app` may INSERT/UPDATE own row (login/refresh resolves `app.citizen_id` from credentials before the query, no bootstrap problem) |
| TBL-038 mfa_factor (auth) | OWN | `citizen_id` |
| TBL-039 auth_event (auth) | OWN read + worker insert | security log; not governance-public; `citizen_id` |

---

## Consequences

RLS here is a real, second, DB-enforced layer for everything AUTH-010 expresses as a same-database scope check — it will actually stop a compromised or buggy `<svc>_app` connection from reading or writing another citizen's private rows, independent of whether the application code above it has a bug. It is explicitly *not* a full reimplementation of AUTH-009/010: cross-service scopes (`jurisdiction:*`, most `assigned` cases) and business-rule conditions (COI, evidence, thresholds, dual-control) stay where they are today, in application code, per §5. No migration tooling or actual service-to-Postgres wiring is decided here (ADR-024 §Consequences) — these migrations exist as the schema+policy layer to wire a real DB connection into, whenever that separate piece of work happens.
