---
id: AUTH-012
type: auth-spec
title: "service identity (machine-to-machine / workload)"
status: draft
layer: implementation
linkedIds: ADR-018,AUTH-010,ARCH-005,ARCH-006
created: 2026-08-23
---

## Overview

Not a human role. This document defines the identity mechanism the 17 domain services (SRV-001 through SRV-017) use to authenticate to each other, per ADR-018. Every pod is issued a short-lived SPIFFE workload identity automatically by the service mesh at startup, one-to-one with its Kubernetes ServiceAccount, which is one-to-one with the SRV service it belongs to. There is no enrollment step and no human ever holds or requests a workload identity — issuance, rotation, and revocation are entirely mesh-managed.

This formalizes, from the authentication side, the mechanism behind AUTH-010's "System-only permissions" table: those permissions are executed by internal workers, and it is a workload identity — never a citizen or operator credential — that proves the calling pod is the worker it claims to be.

---

## Identity issuance

| SRV | Service | Kubernetes ServiceAccount |
|-----|---------|---------------------------|
| SRV-001 | identity-service | `identity-service` |
| SRV-002 | jurisdiction-service | `jurisdiction-service` |
| SRV-003 | problem-service | `problem-service` |
| SRV-004 | proposal-service | `proposal-service` |
| SRV-005 | competency-service | `competency-service` |
| SRV-006 | deliberation-service | `deliberation-service` |
| SRV-007 | budget-service | `budget-service` |
| SRV-008 | voting-service | `voting-service` |
| SRV-009 | civic-duty-service | `civic-duty-service` |
| SRV-010 | delegation-service | `delegation-service` |
| SRV-011 | governance-role-service | `governance-role-service` |
| SRV-012 | audit-service | `audit-service` |
| SRV-013 | project-service | `project-service` |
| SRV-014 | reputation-service | `reputation-service` |
| SRV-015 | notification-service | `notification-service` |
| SRV-016 | ai-synthesis-service | `ai-synthesis-service` |
| SRV-017 | auth-service | `auth-service` |

Each identity follows the SPIFFE format defined in ADR-018: `spiffe://digitaldemocracy/ns/{namespace}/sa/{service-account}`. The mesh's own certificate authority issues and auto-rotates these certificates at 24 hours or less; no service handles or stores its own private key material outside the mesh sidecar, and no operator issues or extends a certificate manually.

---

## Authorization model

Authorization is allow-list based on the exact producer/consumer and sync-call edges already declared in ARCH-005 — a service may only call the sync endpoints and produce or consume the Kafka topics explicitly listed for it in ARCH-005 §1 (service layer overview) and §2 (queue bus topology). Anything not listed is denied by the mesh's default-deny `AuthorizationPolicy`.

| Enforcement point | Mechanism | Keyed on |
|---|---|---|
| Sync service-to-service calls | Mesh `AuthorizationPolicy` | SPIFFE identity |
| Kafka topics (produce/consume) | Kafka ACL | SPIFFE identity |

This extends AUTH-010's enforcement contract — "no service may implement ad hoc authorization logic," "if an operation is not listed here, it is denied by default" — down to the network layer. ARCH-005 becomes an enforced allow-list, not only documentation: a service update that adds a call or topic edge not already in ARCH-005 is a rejected policy violation, not a stale diagram.

---

## System-only permissions — enforcing workload identity

For each system-only permission in AUTH-010, the workload identity of the service owning the executing process is the identity the mesh authenticates when that worker or cron fires.

| Permission ID (AUTH-010) | Executed by | Enforcing workload identity |
|--------------|--------|------------------------------|
| `protocol_change:activate` | DP-043 worker | governance-role-service (SRV-011) |
| `vote_session:schedule` | DP-046 cron | voting-service (SRV-008) |
| `vote_session:certify` | DP-027 worker | voting-service (SRV-008) |
| `eligibility_token:issue` | DP-025 worker | voting-service (SRV-008) |
| `assignment:generate` | DP-040 worker | civic-duty-service (SRV-009) |
| `governance_role:expire` | DP-050 cron | governance-role-service (SRV-011) |
| `citizen:activate` | DP-002 worker | identity-service (SRV-001) |

A valid workload identity is necessary to reach these endpoints and topics at all, but it is not sufficient on its own to grant the permission — the service must still evaluate the AUTH-010 permission record (action, conditions) before acting. The mesh proves who is calling; AUTH-010 still governs what the call is allowed to do.

---

## Restrictions — no privilege escalation via workload identity

Workload identities never carry human-role permissions (AUTH-001 through AUTH-008, AUTH-011) directly. Holding a valid SPIFFE identity authenticates a service to its peers; it grants none of the permissions defined for citizens, experts, auditors, reviewers, oversight, operators, review bodies, or the protocol council.

When a service acts on behalf of a citizen — for example, DP-002 activating a citizen via identity-service — the request still carries that citizen's own authenticated context from auth-service (SRV-017). A service cannot act with authority beyond what the citizen or process it is serving is actually entitled to, merely because it holds a valid workload identity. The workload identity authenticates the transport hop; it does not launder authority.

---

## Certificate lifecycle

- Workload certificates expire in 24 hours or less.
- Rotation is automatic, performed by the mesh certificate authority; no certificate is ever issued or extended manually.
- A pod that fails rotation loses mesh connectivity — sync calls and Kafka connections both fail closed, per ADR-018's default-deny NetworkPolicies.
- Certificate issuance, rotation, and revocation events are out of scope for this document; they are mesh-internal and not modeled as application-level operations.

---

## Enforcement contract

Every service-to-service connection, sync or via Kafka, is subject to:

1. The mesh sidecar presents the calling pod's current SPIFFE certificate on connection setup.
2. The receiving sidecar validates the certificate against the mesh's certificate authority trust bundle; an invalid or expired certificate is dropped at the network layer before any application code runs.
3. The mesh checks the caller's SPIFFE identity against the `AuthorizationPolicy` (sync) or Kafka ACL (topic) allow-listed for that endpoint or topic per ARCH-005.
4. On mismatch, the connection is rejected at the network layer — no ad hoc authorization decision is made by the receiving service itself.
5. A connection that passes 1–4 has proven only which service is calling. It does not satisfy any AUTH-001 through AUTH-011 requirement; where a request carries citizen or operator authority, that authority is still resolved and checked per AUTH-009 and AUTH-010, independent of the workload identity that carried the request.
