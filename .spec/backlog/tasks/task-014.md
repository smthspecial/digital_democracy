---
id: TASK-014
type: task
title: "Provision renewable HTTPS and verified database and broker TLS"
status: in-progress
storyId: US-057
priority: high
dependsOn: TASK-006,TASK-013
linkedIds: REL-002,ADR-018,AUTH-012,BUG-013,BUG-017
created: 2026-10-08
---

## Outcome

Gateway, database and broker connections authenticate their endpoints with maintained certificates.

## Responsible role

Platform engineer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Use cert-manager with the existing gateway controller, owned DNS names and an appropriate staging/production issuer. Provide dd-gateway-tls in the actual application namespaces or explicitly revise route attachment.
- [ ] Require hostname/CA verification for Postgres and NATS clients, plus client authentication/workload identity where required. No insecure-skip-verify or sslmode=disable in production configuration.
- [ ] Provision trust bundles and certificate material through the selected secret mechanism; keep credentials and private keys out of git and images.
- [ ] Test valid connections, wrong host/CA, expired certificates, plaintext fallback and renewal under traffic. Include alerting before expiry and failed renewal.
- [ ] Record certificate/CA rotation and disaster-recovery procedures; verify data-plane connectivity after renewal/restart.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.
