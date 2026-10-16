---
id: TASK-013
type: task
title: "Provision a staging mesh with enforced workload authorization"
status: blocked
storyId: US-057
priority: high
dependsOn: TASK-006
linkedIds: REL-002,ADR-018,ADR-026,ADR-041,AUTH-012,BUG-013,BUG-018
created: 2026-10-08
---

## Outcome

A reproducible self-hosted staging cluster enforces the two-runtime workload policies in live traffic.

## Responsible role

Platform engineer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Pin compatible k3s/Gateway API/Istio/Traefik releases and install them in dependency order. Activate the deferred mesh requirement without silently rewriting historical ADR-026.
- [ ] Inject/configure application, gateway, trusted identity verifier and ballot verifier workloads. Confirm the actual gateway principal can reach the mesh; replace an incompatible gateway pattern if needed.
- [ ] Set the trust domain consistently with AuthorizationPolicy principals; verify automatic workload-certificate rotation at the ADR-018 lifetime.
- [ ] Enforce STRICT mTLS, explicit method/path authorization and producer-header/workload-principal binding; public ingress cannot reach internal writes.
- [ ] Validate NetworkPolicy enforcement and exact DNS/control-plane/database/broker peers. Prove denied plaintext, unmeshed/wrong-account calls, spoofed producer headers and forbidden egress on a live cluster.
- [ ] Update the bootstrap/runbook from the old per-domain Helm paths to infra/helm/apps and add repeatable drift/health checks.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.
