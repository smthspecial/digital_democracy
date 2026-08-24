---
id: AUTH-011
type: auth-spec
title: "platform-operator (SRE / infrastructure)"
status: draft
layer: implementation
linkedIds: AUTH-006,ADR-001,ADR-015,ADR-017,ADR-018,ARCH-003,ARCH-006,ARCH-008,DP-068
created: 2026-08-23
---

## Description

A distinct credential within the Implementation layer (ADR-001, ARCH-003), separate from AUTH-006 (operator). Platform-operators run the Kubernetes clusters, service mesh, per-service databases at the infrastructure level (backups/restores), CI/CD pipelines, and secrets management described in ARCH-006. The role exists so that no single person can hold both civic-ledger authority (AUTH-006: recording ledger entries, reporting project milestones) and cluster-admin authority — separation of duties inside the Implementation layer.

## Acquisition

Standing access follows the same multi-approval appointment path as AUTH-006/DP-063: protocol_council proposal, citizen_supermajority approval, audit_confirmation approval, body_endorsement approval, then a 14-day public delayed-execution window.

Separately, time-boxed break-glass elevation is available during a declared incident via DP-068: dual real-time approval from a second independent platform-operator, auto-expiring in 4 hours or less, with a mandatory post-incident audit review.

## Capabilities

| Capability | Condition |
|-----------|-----------|
| Deploy to Kubernetes (apply manifests/Helm releases) | Standing access, or active break-glass grant, plus dual-control co-approval on any production-affecting change |
| Rotate secrets | Standing access or active break-glass grant |
| Read-only cluster and observability access | Standing access, always available |
| Restore from database backup | Always requires dual control — a second independent platform-operator must co-approve, regardless of standing or break-glass status |

## Restrictions

- Cannot access ballot content or biometric embeddings — those stay encrypted with keys held only by voting-service and auth-service respectively.
- Cannot record ledger entries or report project milestones (AUTH-006's domain).
- Cannot modify governance-rule code paths outside the same protocol-change process everyone else uses (ADR-001) — infrastructure access does not grant a shortcut around governance rules.
- Cannot hold the operator (AUTH-006) role simultaneously, for the same separation-of-duties reason the roles were split.
- All actions are logged to the audit log (DP-036); any production-affecting write additionally requires a second platform-operator's real-time co-approval even during routine (non-incident) work.

## Loss / suspension

- Revocable via the same multi-approval path as acquisition.
- Break-glass grants auto-expire per DP-068 with no separate revocation action needed.
