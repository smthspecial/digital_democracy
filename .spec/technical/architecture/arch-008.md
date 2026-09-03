---
id: ARCH-008
type: arch
title: "Observability, SRE resilience, and disaster recovery"
status: active
created: 2026-08-23
---

## Overview

This document defines how the platform-operator role (AUTH-011, once it exists) monitors, alerts on, and recovers the infrastructure defined in ARCH-006 and ARCH-007, without ever touching governance data or ballot content. It covers the observability stack, per-service SLOs and error budgets, incident response and break-glass access, disaster recovery targets and runbooks, and chaos engineering. Platform-operators run infrastructure; they hold no citizen governance role and no path in this document grants them access to ballot content, biometric embeddings, or the ability to alter a governance outcome.

---

## 1. Observability stack

Every service (SRV-001 through SRV-017, per ARCH-006) is instrumented with OpenTelemetry: traces, metrics, and structured logs share a common `trace_id`/`span_id` context, covering sync request handling, async queue workers, and cron jobs alike. Prometheus scrapes per-service metrics; Grafana renders per-service and cross-service dashboards from them. Logs are shipped to a centralized structured-logging backend (e.g. Loki) and are queryable by `trace_id`, so a log line, a metric spike, and a trace for the same request correlate directly.

Distributed tracing follows a request across the sync-call / async-queue boundary (ADR-023 — NATS JetStream, which superseded ADR-016's Kafka backbone): OpenTelemetry trace context (`traceparent`, `tracestate`) is propagated as NATS message headers on every publish, and every consumer resumes the existing trace on read rather than starting a new one. A single ballot cast is therefore traceable end to end as one trace: the sync `ballot:cast` request into voting-service (DP-016), the `voting.tally` queue hop into the tally worker (DP-026), and the `audit.append` queue hop into audit-service (DP-036) — the same pipeline shown in ARCH-005 diagram 4. (This tracing pipeline itself — the OpenTelemetry collector and a trace-storage backend — is target state, not yet deployed; the current build stage runs a metrics-only slice of this stack, ARCH-025 §2.)

| Signal | Tool | Notes |
|--------|------|-------|
| Traces | OpenTelemetry SDK + collector | trace context propagated through Kafka message headers across queue hops |
| Metrics | Prometheus | scraped per service; feeds Grafana and the SLO burn-rate alerts in Section 2 |
| Logs | Structured logging, centralized (e.g. Loki) | correlated to `trace_id` |
| Dashboards | Grafana | per-service and cross-service; the SLO health dashboard (Section 2) is also exposed outside the platform-operator team |

This is the target stack. ARCH-025 covers what's actually deployed at the current build stage (Prometheus + Grafana + Alertmanager only, on a single self-hosted k3s cluster, no cloud vendor per ADR-026) — traces and centralized logs are not live yet.

---

## 2. Service-level objectives

Each service defines an SLO with a formal error budget. Example: voting-service targets 99.95% availability (NFR-011), with the p99 latency budgets defined in ARCH-007.

| Service / endpoint class | SLI | Target |
|---|---|---|
| voting-service | Availability | 99.95% (NFR-011) |
| voting-service, `ballot:cast` | p99 latency | ≤1s at peak concurrency (ARCH-007 §2) |
| Read-heavy endpoints (problem, proposal, audit-log) | p99 latency | ≤300–500ms (ARCH-007 §2) |
| Write endpoints (`argument:post`, `preference:declare`) | p99 latency | ≤800ms (ARCH-007 §2) |
| All other services, default | Availability | 99.9% |

Every SLO's error budget is monitored on two burn-rate windows. A fast-burn alert (short window, high burn rate) pages the on-call platform-operator (AUTH-011) immediately, and also drives the automatic canary rollback in ARCH-006 §8: a rollout that burns its error budget faster than the configured rate is rolled back before it reaches full traffic, without waiting for a human to notice the page. A slow-burn alert (long window, low burn rate) opens a ticket for the platform-operator team; it does not page and does not trigger a rollback.

The SLO health dashboard is not purely an internal engineering artifact. It is visible to the audit/oversight layer (AUTH-003, AUTH-005) alongside the public audit log, as a transparency measure — infrastructure health in a system that carries national governance decisions is not solely an internal operational concern.

---

## 3. Incident response

On-call is staffed exclusively by platform-operators (AUTH-011), on a rotation. Citizen governance-role holders — auditor (AUTH-003), oversight (AUTH-005), review body (AUTH-007), protocol council (AUTH-008) — never carry infrastructure on-call; per the Implementation/Audit separation in ARCH-003, their function is to observe and review, not to operate.

Severity levels:

| Severity | Definition | Break-glass eligible |
|---|---|---|
| SEV1 | Governance-critical data (`ballot`, `audit_log`, `governance_role`) at risk, or a national vote session directly impacted | Yes |
| SEV2 | Single-service outage or major degradation affecting citizens, no governance-critical data at risk | Yes |
| SEV3 | Degraded performance, no citizen-facing impact | No — standard on-call response |
| SEV4 | Minor, non-urgent | No — ticket only |

Break-glass elevated access is invoked only during a declared incident of SEV2 or higher, never outside one, and never as a substitute for the standing multi-approval appointment path that ordinary platform-operator access follows. This grant and its mandatory review are DP-068: dual-control approval from a second, independent, on-call platform-operator; auto-expiry at 4 hours or less with no separate revocation step required; and a mandatory post-incident review by an active audit body (AUTH-003), due within 48 hours of grant issuance. Every action taken under a break-glass grant, and the grant itself, is emitted to the audit log (DP-036), tagged with the incident reference.

---

## 4. Disaster recovery

RTO and RPO targets, per ADR-017:

| Tier | Tables | RTO | RPO |
|------|--------|-----|-----|
| Governance-critical | `ballot`, `audit_log`, `governance_role` | ≤5 minutes | ≤30 seconds |
| Everything else | All other tables | ≤30 minutes | ≤5 minutes |

Runbooks are maintained per failure class:

| Failure class | Response |
|---|---|
| Full region loss | Edge traffic fails over to a healthy region via the GeoDNS/anycast layer (ADR-017); the Postgres standby in the synchronously-replicated second region is promoted; the asynchronously-replicated third region catches up. |
| Kafka cluster loss | Kafka runs one independent cluster per region, not a globally shared cluster (ARCH-006 §1, §4). A region's cluster failing independently of the rest of that region's infrastructure fails that region's traffic over via the same GeoDNS/edge path as a full region loss. `audit.append` is unaffected regardless, since it is mirrored to the other two regions' clusters via MirrorMaker 2 (ARCH-006 §4); other queues resume from the last committed offset once the cluster is restored, per the durable log's replay guarantee (ADR-016) — delayed, not lost. |
| Single-service outage | Kubernetes reschedules affected pods within a healthy region; if the outage is region-wide for that one service, its traffic routes to a healthy-region replica while other services are unaffected. |
| Database corruption | A platform-operator restores from backup under mandatory dual control (AUTH-011) — restore always requires a second, independent platform-operator's co-approval, regardless of standing or break-glass status. |

A full quarterly DR drill fails over live traffic to a secondary region (NFR-011). Drill results — time achieved against the RTO/RPO targets above, and any deviations — are published to the audit log (DP-036), so drill outcomes are publicly verifiable, not only internally reported.

---

## 5. Chaos engineering

Scheduled fault injection — pod kill, network partition, simulated region isolation — runs in a staging environment sized to mirror the ARCH-007 capacity plan, so failure behavior observed in staging is representative of production behavior at national scale.

Chaos exercises run before every major release and before every national vote session, coordinating with the load-and-chaos-testing plan in ARCH-007 §6 and satisfying the measurement clause of NFR-009. Findings that reveal a gap against the SLOs in Section 2 or the RTO/RPO targets in Section 4 feed back into the runbooks in Section 4, and, where the gap is structural, into a proposed ADR revision — chaos engineering verifies this document's targets rather than running as a process apart from them.
