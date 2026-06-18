---
id: ARCH-005
type: arch
title: "System interaction diagrams: services, queues, and data flows"
status: active
created: 2026-06-18
---

## Overview

Four diagrams describe the runtime topology of the system. The first shows how services are organized by layer and which queues they share. The second shows the queue bus in detail: every producer–consumer pair. The third traces the full governance lifecycle from problem submission to project outcome. The fourth isolates the voting pipeline and its cryptographic identity–ballot separation.

All sync operations flow directly from an actor to a service. All async operations flow through a named queue. Cron jobs fire from the scheduler into service workers or directly into queues.

---

## 1. Service layer overview

Services are organized across five independent layers. Arrows show the primary direction of data flow; every service additionally writes to `audit.append` and `notifications.dispatch` (omitted here for readability — shown in diagram 2).

```mermaid
flowchart TD
    CITIZEN(["Citizen"])
    OPERATOR(["Operator"])
    CRON(["Cron Scheduler"])

    subgraph CITIZEN_LAYER["Layer 1–2 · Identity & Jurisdiction"]
        IDENT["identity-service\nSRV-001"]
        JURI["jurisdiction-service\nSRV-002"]
    end

    subgraph PROPOSAL_LAYER["Layer 3–5 · Problem → Proposal → Expertise"]
        PROB["problem-service\nSRV-003"]
        PROP["proposal-service\nSRV-004"]
        COMP["competency-service\nSRV-005"]
        DELIB["deliberation-service\nSRV-006"]
        AI["ai-synthesis-service\nSRV-016"]
    end

    subgraph BUDGET_VOTE_LAYER["Layer 6–7 · Budget & Voting"]
        BUDGET["budget-service\nSRV-007"]
        VOTE["voting-service\nSRV-008"]
        DELEG["delegation-service\nSRV-010"]
    end

    subgraph CIVIC_LAYER["Layer 8–9 · Civic Duty & Governance"]
        CIVIC["civic-duty-service\nSRV-009"]
        GROLE["governance-role-service\nSRV-011"]
    end

    subgraph IMPL_LAYER["Layer 10 · Implementation & Oversight"]
        PROJ["project-service\nSRV-013"]
    end

    subgraph INTEGRITY_LAYER["Cross-cutting · Integrity & Support"]
        AUDIT["audit-service\nSRV-012"]
        REP["reputation-service\nSRV-014"]
        NOTIF["notification-service\nSRV-015"]
    end

    CITIZEN -->|"sync write"| IDENT
    CITIZEN -->|"sync write"| PROB
    CITIZEN -->|"sync write"| PROP
    CITIZEN -->|"sync write"| COMP
    CITIZEN -->|"sync write"| DELIB
    CITIZEN -->|"sync write"| BUDGET
    CITIZEN -->|"sync write"| VOTE
    CITIZEN -->|"sync write"| DELEG
    OPERATOR -->|"sync write"| BUDGET
    OPERATOR -->|"sync write"| PROJ
    CRON -->|"triggers"| IDENT
    CRON -->|"triggers"| COMP
    CRON -->|"triggers"| PROP
    CRON -->|"triggers"| VOTE
    CRON -->|"triggers"| CIVIC
    CRON -->|"triggers"| GROLE
    CRON -->|"triggers"| BUDGET
    CRON -->|"triggers"| PROJ

    IDENT -->|"eligibility check"| JURI
    PROB -->|"threshold event"| PROP
    PROP -->|"scope check"| JURI
    PROP -->|"vote session"| VOTE
    DELIB -->|"synthesis trigger"| AI
    COMP -->|"COI exclusion"| GROLE
    DELEG -->|"chain resolution"| VOTE
    VOTE -->|"participation signal"| REP
    PROJ -->|"eval trigger"| CIVIC
    CIVIC -->|"assignment"| GROLE

    AUDIT -.-|"read-only\n(multiple bodies)"| AUDIT
```

---

## 2. Queue bus topology

Every named queue in the system, with its producers (→ Q) and consumers (Q →). The `audit.append` and `notifications.dispatch` queues are consumed by exactly one service each; all other services produce to them.

```mermaid
flowchart LR
    subgraph PRODUCERS["Producers"]
        P_IDENT["identity-service"]
        P_PROB["problem-service"]
        P_PROP["proposal-service"]
        P_COMP["competency-service"]
        P_DELIB["deliberation-service"]
        P_VOTE["voting-service"]
        P_CIVIC["civic-duty-service"]
        P_DELEG["delegation-service"]
        P_GROLE["governance-role-service"]
        P_PROJ["project-service"]
        P_REP["reputation-service"]
        P_ALL["all services"]
        CRON_P["Cron Scheduler"]
    end

    subgraph QUEUES["Message Queues"]
        direction TB
        QIC(["identity.check"])
        QIR(["identity.revoke"])
        QPT(["proposals.threshold"])
        QPL(["proposals.lifecycle"])
        QPS(["proposals.scope"])
        QCR(["competency.review"])
        QCC(["competency.challenge"])
        QCOI(["integrity.coi"])
        QCN(["constitutional.review"])
        QGA(["governance.approvals"])
        QGP(["governance.protocol"])
        QVE(["voting.eligibility"])
        QVT(["voting.tally"])
        QVC(["voting.certify"])
        QVD(["voting.delegation"])
        QCA(["civic.assign"])
        QRU(["reputation.update"])
        QAI(["ai.synthesis"])
        QAA(["audit.append"])
        QND(["notifications.dispatch"])
    end

    subgraph CONSUMERS["Consumers"]
        C_IDENT["identity-service"]
        C_PROP["proposal-service"]
        C_COMP["competency-service"]
        C_VOTE["voting-service"]
        C_CIVIC["civic-duty-service"]
        C_DELEG["delegation-service"]
        C_GROLE["governance-role-service"]
        C_AUDIT["audit-service"]
        C_REP["reputation-service"]
        C_NOTIF["notification-service"]
        C_AI["ai-synthesis-service"]
    end

    P_IDENT --> QIC --> C_IDENT
    P_IDENT --> QIR --> C_IDENT

    P_PROB --> QPT --> C_PROP
    P_PROP --> QPL --> C_PROP
    P_PROP --> QPS --> C_PROP
    P_PROP --> QCN --> C_AUDIT

    P_COMP --> QCR --> C_COMP
    P_COMP --> QCC --> C_COMP
    P_COMP --> QCOI --> C_COMP
    QCOI -.->|"also notifies"| C_GROLE

    P_GROLE --> QGA --> C_GROLE
    P_GROLE --> QGP --> C_GROLE

    CRON_P --> QVE --> C_VOTE
    CRON_P --> QVT --> C_VOTE
    QVT --> QVC --> C_VOTE
    P_DELEG --> QVD --> C_DELEG

    P_PROP --> QCA --> C_CIVIC
    P_PROJ --> QCA
    CRON_P --> QCA

    P_VOTE --> QRU --> C_REP
    P_PROJ --> QRU
    P_COMP --> QRU

    P_DELIB --> QAI --> C_AI

    P_ALL --> QAA --> C_AUDIT
    P_ALL --> QND --> C_NOTIF
```

---

## 3. Governance lifecycle flow

The end-to-end pipeline from problem submission through project outcome evaluation. Gates are shown as diamonds; async queue hops are labeled.

```mermaid
flowchart TD
    C(["Citizen"])

    C -->|"DP-003"| SUBMIT_PROB["Submit Problem\nproblem-service"]
    SUBMIT_PROB -->|"public immediately"| ENDORSE["Endorse Problem\nDP-004 · problem-service"]
    ENDORSE -->|"proposals.threshold"| THRESH{"Support\nthreshold\nreached?"}
    THRESH -- No --> ENDORSE
    THRESH -->|"Yes · proposals.lifecycle"| DEVPHASE["Development Phase\nproposal-service\nDP-029"]

    DEVPHASE --> BUDGET_GATE{"Budget &\nscope\ncomplete?"}
    BUDGET_GATE -- No --> FILL["Add budget / scope\nDP-007, DP-006"]
    FILL --> BUDGET_GATE
    BUDGET_GATE -->|"Yes · constitutional.review"| CONST_CHECK["Constitutional Review\naudit-service\nDP-034"]

    CONST_CHECK --> CONST_RESULT{"Rights\nviolation?"}
    CONST_RESULT -- Blocked --> BLOCKED["Proposal blocked\nor escalated to\nreview_body"]
    CONST_RESULT -->|"Cleared · proposals.scope"| SCOPE["Scope Assignment\nproposal-service\nDP-030"]

    SCOPE --> COOLING["Cooling-off period\nDP-057 check\nvoting-service"]
    COOLING -->|"voting.eligibility\nDP-025"| TOKEN_BATCH["Eligibility Token\nBatch Issuance\nvoting-service"]

    TOKEN_BATCH --> VOTE_OPEN["Vote Session Open\nDP-046"]
    C -->|"DP-016"| CAST["Cast Ballot\nvoting-service\n(encrypted, no citizen_id)"]
    VOTE_OPEN --> CAST
    CAST -->|"DP-017"| VERIFY["Voter verifies\nown ballot inclusion"]

    VOTE_OPEN -->|"DP-047"| CLOSE["Vote Session Close\nvoting-service"]
    CLOSE -->|"voting.tally\nDP-026"| TALLY["Tally Computation\n(threshold cryptography\ndecryption)"]
    TALLY -->|"voting.certify\nDP-027"| CERTIFY{"Quorum &\nthreshold\nmet?"}
    CERTIFY -- No --> FAILED["Vote failed\n(quorum or threshold)"]
    CERTIFY -- Yes --> APPROVED["Proposal Approved\nproposal-service\nstatus=approved"]

    APPROVED --> PROJECT["Project Created\nproject-service\nSRV-013"]
    PROJECT --> MILESTONES["Milestone Tracking\nDP-018 · operator/oversight"]
    MILESTONES -->|"DP-053"| EVAL_TRIGGER["Evaluation Triggered\ncivic-duty-service\nDP-040"]
    EVAL_TRIGGER --> EVAL["Outcome Evaluation\nDP-022 · auditor/oversight"]
    EVAL --> PUBLISH["Outcome Published\noucome_evaluation table\nFR-048"]

    TALLY -->|"reputation.update\nDP-038"| REP["Reputation Update\nreputation-service"]
    APPROVED -->|"audit.append\nDP-036"| AUDIT_LOG[("audit_log\naudit-service")]
    MILESTONES --> AUDIT_LOG
    EVAL --> AUDIT_LOG
```

---

## 4. Voting pipeline — cryptographic identity–ballot separation

Zoomed-in view of the voting flow showing how eligibility and ballot are kept in separate cryptographic domains (ADR-002). The bridge is a blind-signed one-time token that cannot be used to link a citizen to a ballot.

```mermaid
flowchart TD
    subgraph IDENTITY_DOMAIN["Identity Domain (citizen_id visible)"]
        CITIZEN(["Citizen\n(active identity)"])
        JURI["jurisdiction-service\nresidency check"]
        ELIG_TOKEN["eligibility_token\nTBL-021\ncitizen_id | session_id\nblinded_token_hash | used"]
    end

    subgraph BALLOT_DOMAIN["Ballot Domain (no citizen_id)"]
        BALLOT["ballot\nTBL-022\ntoken_blind | encrypted_choice\nverification_code\nNO citizen_id"]
        TALLY_WORKER["Tally Worker\nDP-026\nthreshold decryption\n(distributed key holders)"]
        RESULT["Certified Result\nvote_session\nstatus=certified"]
    end

    subgraph QUEUE_BUS["Queue Bus"]
        QVE(["voting.eligibility"])
        QVT(["voting.tally"])
        QVC(["voting.certify"])
        QVD(["voting.delegation"])
        QAA(["audit.append"])
        QND(["notifications.dispatch"])
    end

    VOTE_SCHED["Vote Session Scheduled\nDP-046 · cron trigger\nvote_session opens_at"] -->|"fires"| QVE
    QVE -->|"batch: one token per eligible citizen"| ELIG_CHECK{"Eligible?\nresidency +\njurisdiction\nmembership"}
    JURI -->|"read"| ELIG_CHECK
    ELIG_CHECK -- Yes --> ELIG_TOKEN
    ELIG_CHECK -- No --> EXCLUDED["Citizen excluded\n(not in scope jurisdiction)"]

    CITIZEN -->|"DP-016\npresents blind token"| CAST{"Token valid?\nused=false?"}
    ELIG_TOKEN -->|"blinded token issued\nto citizen (off-channel)"| CITIZEN
    CAST -- No --> REJECTED["Ballot rejected"]
    CAST -- Yes --> WRITE_BALLOT["Write ballot row\n(no citizen_id)\nmark token used=true\n— single transaction —"]
    WRITE_BALLOT --> BALLOT

    CITIZEN -->|"DP-017\nverification_code"| VERIFY["Verify ballot\ninclusion\n(no identity link)"]
    VERIFY --> BALLOT

    VOTE_CLOSE["Vote Session Close\nDP-047 · cron trigger"] -->|"fires"| QVT
    QVT --> TALLY_WORKER
    BALLOT -->|"read encrypted choices"| TALLY_WORKER
    TALLY_WORKER -->|"fires"| QVC
    QVC --> CERTIFY{"Quorum\n+ threshold\nmet?"}
    CERTIFY -- Yes --> RESULT
    CERTIFY -- No --> FAILED_SESSION["Session: failed quorum"]

    DELEGATION(["Active Delegation\nTBL-023"]) -->|"DP-041\nvoting.delegation"| QVD
    QVD -->|"chain resolution"| WRITE_BALLOT

    RESULT -->|"DP-036"| QAA --> AUDIT_LOG[("audit_log\n(session event only\nno ballot content)")]
    RESULT -->|"DP-039"| QND --> NOTIF["notification-service\nresult dispatched"]
    RESULT -->|"DP-038\nreputation.update"| REP["reputation-service\nparticipation signal"]
```

---

## 5. Integrity bus

Every service emits to two shared queues. This diagram shows all services as producers of `audit.append` and `notifications.dispatch`, and the single consumer of each.

```mermaid
flowchart LR
    subgraph SERVICES["All services (producers)"]
        S1["identity-service"]
        S2["jurisdiction-service"]
        S3["problem-service"]
        S4["proposal-service"]
        S5["competency-service"]
        S6["deliberation-service"]
        S7["budget-service"]
        S8["voting-service"]
        S9["civic-duty-service"]
        S10["delegation-service"]
        S11["governance-role-service"]
        S12["project-service"]
        S13["reputation-service"]
        S14["ai-synthesis-service"]
    end

    QAA(["audit.append\n(at-least-once\nhash-chained ordering)"])
    QND(["notifications.dispatch\n(at-least-once\nbest-effort delivery)"])

    S1 & S2 & S3 & S4 & S5 & S6 & S7 & S8 & S9 & S10 & S11 & S12 & S13 & S14 --> QAA
    S1 & S3 & S4 & S5 & S7 & S8 & S9 & S10 & S11 & S12 & S13 --> QND

    QAA -->|"single consumer\nexact ordering enforced"| AUDIT["audit-service\nSRV-012\nappend-only\nhash-chained\npublicly verifiable"]
    QND -->|"single consumer\ndelivery failure\ndoes not block upstream"| NOTIF["notification-service\nSRV-015\nmulti-channel\n(email, push, in-app)"]

    AUDIT -->|"read-only\nmultiple concurrent\naudit bodies"| AUDITORS(["Auditors\nFR-066"])
    AUDIT -->|"public read"| PUBLIC(["Citizens\n(public ledger)"])
```
