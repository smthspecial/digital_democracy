---
id: EPIC-013
type: epic
title: "Platform Reliability, Scale & Security Operations"
status: active
priority: high
created: 2026-08-23
---

## Description

Ensure the platform itself—not just the governance rules it implements—can carry national-scale democratic participation reliably. Covers running the system as independently deployable, autoscaling microservices on Kubernetes; sustaining 10 million registered and 100,000 concurrent active citizens with defined latency targets; surviving regional outages without losing governance data; and keeping infrastructure/cluster access credentialed and audited separately from civic-ledger authority, so infrastructure control cannot become its own path to capturing the system.

## Acceptance Criteria

- [ ] The system sustains 100,000 concurrent active citizens with defined p99 latency targets, including during national vote-close surges
- [ ] A full regional outage triggers automated failover without losing any cast ballot or audit log entry
- [ ] Infrastructure/cluster access (platform-operator) is a separate, independently multi-approved credential from civic-ledger access (operator)
- [ ] Emergency infrastructure access is time-boxed, dual-approved, and always subject to mandatory post-incident audit review
- [ ] Load-test and disaster-recovery drill results are published and independently verifiable, consistent with the system's transparency principles

## Notes

Source: this epic formalizes the scale and infrastructure requirements in NFR-009 (Scalability) and NFR-011 (Availability and resilience) into concrete platform capabilities, per ADR-015 through ADR-018 and ARCH-006 through ARCH-008. Implements the same functional requirements NFR-009/NFR-011 already link to, and introduces AUTH-011 and AUTH-012.
