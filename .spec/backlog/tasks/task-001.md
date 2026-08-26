---
id: TASK-001
type: task
title: "Implement identity-service DP-001/DP-002 (register + verify)"
status: done
storyId: US-001
priority: high
created: 2026-08-26
---

## Description

Implemented `identity-service` (SRV-001) beyond the health-check scaffold:
Postgres schema for TBL-001/TBL-002, `POST /citizens` (DP-001), `POST
/verifications` (DP-002, activates the citizen on approval), `GET
/citizens/:id`, and the DP-024 duplicate-detection event publish. FR-001's
single-active-identity guarantee is enforced synchronously by a partial
unique index on `legal_identity_hash`, not just DP-024's async pass.

## Notes

- Fixed `.spec/technical/database/tbl-001.md`: its `status` enum was
  missing `pending`, which DP-001/DP-002 require.
- Not yet implemented: DP-042 (revocation cascade), DP-056 (weekly
  duplicate sweep cron), and a real Kafka producer behind `src/events.ts`
  (currently a logging stub) and a real verification provider behind
  `src/verification-provider.ts` (currently approves any non-empty
  evidence reference).
