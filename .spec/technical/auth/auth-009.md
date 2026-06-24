---
id: AUTH-009
type: auth-spec
title: "Authorization matrix"
status: draft
linkedIds: ADR-001,ADR-002,ADR-014,AUTH-010,FR-003,FR-007,FR-020,FR-025,FR-041,FR-058,FR-061,FR-063,FR-065,FR-067,NFR-001
created: 2026-06-18
---

## Overview

Authorization in the system is role-based with four constraint layers: (1) scope guards — the citizen must be eligible for the jurisdiction of the target resource; (2) COI guards — citizens with an undisclosed or active conflict of interest are excluded from affected decisions; (3) term guards — time-limited roles are only active within their declared `term_start..term_end`; (4) MFA tier guards — each action requires a minimum session assurance tier (T1/T2/T3) as defined in AUTH-010 and ADR-014.

**The canonical per-permission definitions (action, scope, conditions, MFA tier) live in AUTH-010.** This matrix is the operation-level view, mapping operations to the minimum required role and any additional guards beyond what AUTH-010 specifies.

Roles are cumulative: every role includes all capabilities of AUTH-001 (citizen). A COI flag on any role immediately removes that role's capabilities in the conflicted domain.

### Role assignment processes

| Role | How granted | Process |
|------|------------|---------|
| citizen | Auto on identity verification | DP-002 |
| expert | Auto when `competency.status=active` | DP-031 |
| auditor | Random selection + acceptance | DP-040 → DP-062 |
| reviewer | Random selection + acceptance | DP-040 → DP-062 |
| oversight | Random selection + acceptance | DP-040 → DP-062 |
| review_body | Weighted random + acceptance | DP-065 → DP-062 |
| operator | Multi-approval appointment | DP-063 |
| protocol_council | Citizen election | DP-064 |

---

## Identity and verification

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Register civic identity | DP-001 | unauthenticated | — |
| Submit verification evidence | DP-002 | AUTH-001 (status=pending) | Own identity only |
| Revoke own identity | — | AUTH-001 | Requires multi-approval from AUTH-008 + AUTH-003 + AUTH-007 (FR-007) |
| Revoke another citizen's identity | DP-042 | AUTH-008 | Must pass DP-035 multi-approval; cannot be unilateral |
| Suspend a citizen | DP-042 | AUTH-008 | Must pass DP-035; logged (FR-007) |

---

## Problems

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Submit problem | DP-003 | AUTH-001 | Active identity |
| Endorse problem | DP-004 | AUTH-001 | Active identity; unique per (citizen, problem) |
| View all problems | read | AUTH-001 | Public |

---

## Proposals

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Create proposal | DP-005 | AUTH-001 | Active identity |
| Add constraint to proposal | DP-006 | AUTH-001 | Proposal author; proposal status in (draft, gathering_support, development) |
| Add / update budget info | DP-007 | AUTH-001 | Proposal author |
| File scope challenge | DP-020 | AUTH-001 | Active identity; affected jurisdiction member |
| Resolve scope challenge | DP-030 | AUTH-007 | Active term; COI guard |
| Advance proposal to voting | DP-029 | system (async worker) | Scope set; budget complete; constitutional review cleared; threshold met |

---

## Deliberation

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Post argument | DP-008 | AUTH-001 | Active identity; evidence_ref required |
| Declare preference | DP-009 | AUTH-001 | Active identity; before solution phase |
| Lock agreed-fact branch | — | AUTH-007 | Review body assigned to proposal; within scope |

---

## Competency and expert actions

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Apply for competency | DP-011 | AUTH-001 | Active identity |
| Publish expert assessment | DP-021 | AUTH-002 | Active competency in proposal's domain; no undisclosed COI |
| Declare conflict of interest | DP-010 | AUTH-002 | Self-disclosure only |
| Submit competency challenge | DP-012 | AUTH-001 | Evidence reference required; anonymous submissions rejected |
| Decide competency challenge | DP-032 | AUTH-007 | Domain-expert support recommended; COI guard |

---

## Budget

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Submit budget allocation vote | DP-013 | AUTH-001 | Active identity; per period; totals must sum to 100% |
| Record ledger entry | DP-019 | AUTH-006 | Active operator credential; logged to audit |
| View ledger | read | AUTH-001 | Public real-time |

---

## Voting

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Cast ballot | DP-016 | AUTH-001 | Active identity; valid eligibility_token (used=false); token is cryptographically issued at session open |
| Verify ballot inclusion | DP-017 | unauthenticated | Requires only the verification_code; no citizen linkage |
| Create delegation | DP-014 | AUTH-001 | Delegate must hold AUTH-002 with active competency in the domain |
| Revoke delegation | DP-015 | AUTH-001 | Own delegations only; immediate effect |
| Schedule vote session | DP-025 | system | Triggered by proposal-service; constitutional review cleared; scope set |
| Certify vote session | DP-027 | system | Tally complete; quorum met |

---

## Civic duty and assignments

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Accept / complete civic assignment | DP-040 | AUTH-001 | Own assignments only |
| Abandon civic assignment | — | AUTH-001 | Own assignments; recorded in participation_record |
| Claim exemption | — | AUTH-001 | Verification required; auditable |
| Generate assignment (randomized) | DP-040 | system | Executed by civic-duty-service only; citizens cannot self-assign |
| Refresh audit pool | DP-054 | system (cron) | No human initiation |

---

## Auditing and oversight

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Access audit pool assignment | civic_assignment | AUTH-003 | Active term; within assigned scope |
| Submit audit finding | DP-022 | AUTH-003 | Active term; within assigned scope |
| Submit outcome evaluation | DP-022 | AUTH-003 or AUTH-005 | Active term; assigned to evaluation task |
| Report project milestone | DP-018 | AUTH-005 or AUTH-006 | Within assigned project |
| Flag budget deviation | — | AUTH-005 | Active term; assigned project |
| Read audit log | read | AUTH-001 | Public; multiple concurrent audit bodies (FR-066) |

---

## Governance roles and protocol

| Operation | Process | Min role | Additional guards |
|-----------|---------|----------|-------------------|
| Submit approval decision | DP-023 | Appropriate governance role per approval_type | Active term; COI guard; cannot supply two approval types for the same action |
| Propose protocol change | — | AUTH-008 | Active term |
| Activate protocol change | DP-043 | system | All three approval types satisfied; delay elapsed; publicly visible during delay |
| Elect protocol council | vote session | AUTH-001 | Standard vote session with certified results |
| Constitutional review decision | DP-034 | AUTH-007 | Assigned review; COI guard; decision is public |

---

## System / cross-cutting guards

| Guard | Applies to | Description |
|-------|-----------|-------------|
| Active identity guard | All citizen-initiated writes | `citizen.status=active` required |
| Jurisdiction eligibility guard | Voting, endorsement, scope challenge | Citizen must be a member of the proposal's `scope_jurisdiction` or a nested parent |
| COI exclusion guard | Expert actions, governance role actions, review body decisions | Any active `conflict_of_interest` in the relevant domain automatically excludes the citizen from that operation (DP-033, FR-063) |
| Term guard | All governance roles | `governance_role.term_start <= now() <= term_end` enforced at every operation |
| Randomization guard | Auditor, audit pool, reviewer, protocol council election | Citizens cannot self-assign to randomized roles; worker validates `randomized=true` |
| Multi-approval guard | Identity suspension/revocation, critical system changes, protocol changes | No single actor can complete; approval types must come from independent role holders |
| Audit log guard | All governance-relevant writes | Every write that touches a governance table emits an event to `audit.append`; operations that fail to produce an audit event are surfaced as integrity alerts |
| Ballot secrecy guard | Voting | `ballot` has no `citizen_id`; the eligibility_token bridge is one-time and non-reversible (ADR-002) |
