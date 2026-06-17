---
id: ARCH-003
type: arch
title: "Governance infrastructure layers and anti-capture separation"
status: active
created: 2026-06-18
---

## Overview

Beneath the functional layers, governance infrastructure is split into four independent control layers so that no single actor or aligned group can unilaterally control the system. Power is decomposed, not eliminated: every powerful action requires observable coordination across independent actors and leaves permanent evidence.

## Details

Control layers and constraints: Protocol Layer defines voting/identity/jurisdiction/lifecycle rules and changes require supermajority + time-delay + independent audit + public visibility (FR-067). Implementation Layer (operators) runs infrastructure but cannot modify rules, alter outcomes, change identity logic, or override audits. Audit Layer observes and reports but cannot execute or approve. Citizen Layer holds final decision authority. Anti-capture mechanisms: immutable action log (FR-060), multi-approval (FR-061), rotating randomized roles (FR-062), conflict-of-interest enforcement (FR-063), standardized compensation (FR-064), delayed execution (FR-065), redundant auditing (FR-066). Realizes NFR-008, NFR-011, NFR-015. See ADR-001, ADR-005, ADR-011.
