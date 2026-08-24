---
id: ARCH-007
type: arch
title: "Scalability and capacity plan: 10M registered / 100K concurrent citizens"
status: active
created: 2026-08-23
---

## Overview

Capacity-planning companion to ADR-017 and NFR-009. Translates the national-scale target into concrete design figures for load, latency, throughput, data sizing, and scaling levers.

The figures in this document are target design figures for capacity planning, derived from the scale target in NFR-009, not measured production facts. They are to be validated and revised after real load testing.

---

## 1. Load model

| Metric | Target |
|--------|--------|
| Total registered citizens | 10,000,000 |
| Sustained concurrent active target | 100,000 |
| Burst headroom target | 300,000 (3x sustained), during a national vote-close window |
| Typical non-election baseline concurrency | ~5,000–20,000 |

---

## 2. Per-operation latency targets

p99 latency targets under peak load.

| Operation | Target | Condition |
|-----------|--------|-----------|
| `ballot:cast` | <= 1s | at 100,000 concurrent submitters within a vote window |
| Read endpoints (problem, proposal, audit-log) | <= 300–500ms | served from cache / read replicas |
| Write endpoints (`argument:post`, `preference:declare`) | <= 800ms | — |

---

## 3. Throughput planning

Illustrative example: sustaining 100,000 concurrent citizens casting a ballot across a multi-hour vote-close window implies a moderate sustained average request rate. The final hour before close concentrates a disproportionate share of remaining voters, driving a sharp peak well above that average.

Target sustained peak: ~2,000 ballot-casts per second, with burst headroom to ~5,000 per second.

Kafka partition counts and voting-service replica counts must be sized to this peak, not the average.

---

## 4. Data sizing

| Dataset | Volume | Notes |
|---------|--------|-------|
| `citizen` rows | ~10,000,000 | steady-state, grows with registration |
| `ballot` rows per national vote session | up to 10,000,000 | write-once, never updated |
| `audit_log` | append-only, unbounded growth | hash-chained (ADR-006) |

`audit_log` requires partitioning by time and/or jurisdiction, plus a cold-storage archival tier after a defined retention window. The archival tier must remain hash-chain-verifiable — archived partitions cannot break the chain of custody back to genesis.

---

## 5. Scaling levers by bottleneck

| Bottleneck | Lever |
|-----------|-------|
| identity-service reads | Caching plus read replicas |
| voting-service writes | `ballot` table partitioned by `vote_session_id`; dedicated high-IOPS storage class; KEDA-scaled tally workers |
| Kafka | Partition counts sized to the peak throughput target, per topic |
| Postgres | Connection pooling via PgBouncer (per ARCH-006) to avoid connection exhaustion as pod replica counts grow |

---

## 6. Load and chaos testing plan

- Recurring load test simulating the full election-day traffic profile, run before every national vote session.
- Scheduled game-day chaos exercises on a fixed cadence: region failure, Kafka broker loss, database failover.
- Chaos exercises are coordinated with the disaster-recovery plan in ARCH-008.
