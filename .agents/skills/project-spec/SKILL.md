---
name: project-spec
description: Use whenever this workspace's .spec/ folder is involved — answering questions about requirements, epics, stories, tasks, bugs, sprints, releases, ADRs, architecture, services, database tables, CI/CD, auth specs, team members, or product concept docs, and before creating or editing any file under .spec/. Also use for "find", "search", "what do we have on", or "is there a spec for" style questions.
---

# Project Spec

All project documentation lives in `.spec/` as YAML front-matter Markdown files. There's no special tool or server for reading or writing them — use your normal file tools directly, following the schema below.

## Finding existing spec content

Before creating a new item, check whether one already exists: `Grep` for keywords across `.spec/**/*.md`, or `Glob` a specific type's directory (e.g. `.spec/backlog/epics/*.md`) when you already know the type. Check `linkedIds` / `dependsOn` / `epicId` / `storyId` front matter to trace relationships between items.

## Creating or editing a spec item

1. Check the type registry below for the front-matter fields, directory, file name, and valid statuses.
2. List existing files of that type (e.g. `ls .spec/backlog/epics/`) to find the next available sequential number and check for duplicates.
3. Write the file directly at its workspace-relative path, e.g. `.spec/backlog/epics/epic-004.md`.
4. Re-read what you wrote and check it against Key Rules below — there's no separate validation tool, so this pass is on you.

This applies whether you're creating one item or a whole batch (e.g. an epic with its stories and tasks) — repeat steps 1–4 per file.

## Type registry — the only 18 valid document types

| `type` | `id` prefix | Directory under `.spec/` | File name | Valid `status` values |
|--------|-------------|--------------------------|-----------|----------------------|
| `epic` | `EPIC-NNN` | `backlog/epics/` | `epic-NNN.md` | `draft` · `active` · `done` |
| `story` | `US-NNN` | `backlog/stories/` | `us-NNN.md` | `draft` · `active` · `done` |
| `task` | `TASK-NNN` | `backlog/tasks/` | `task-NNN.md` | `todo` · `in-progress` · `testing` · `blocked` · `done` |
| `bug` | `BUG-NNN` | `backlog/tasks/` | `bug-NNN.md` | `todo` · `in-progress` · `testing` · `blocked` · `done` |
| `fr` | `FR-NNN` | `requirements/fr/` | `fr-NNN.md` | `draft` · `active` · `deprecated` |
| `nfr` | `NFR-NNN` | `requirements/nfr/` | `nfr-NNN.md` | `draft` · `active` · `deprecated` |
| `sprint` | `SPR-NNN` | `planning/sprints/` | `spr-NNN.md` | `planned` · `active` · `done` |
| `release` | `REL-NNN` | `planning/releases/` | `rel-NNN.md` | `draft` · `active` · `released` |
| `adr` | `ADR-NNN` | `technical/adr/` | `adr-NNN.md` | `proposed` · `accepted` · `deprecated` · `superseded` |
| `arch` | `ARCH-NNN` | `technical/arch/` | `arch-NNN.md` | `draft` · `active` · `deprecated` |
| `service` | `SRV-NNN` | `technical/services/` | `srv-NNN.md` | `draft` · `active` · `deprecated` |
| `data-proc` | `DP-NNN` | `technical/data-processes/` | `dp-NNN.md` | `draft` · `active` · `deprecated` |
| `db-table` | `TBL-NNN` | `technical/database/` | `tbl-NNN.md` | `draft` · `active` · `done` |
| `cicd` | `CICD-NNN` | `technical/cicd/` | `cicd-NNN.md` | `draft` · `active` · `deprecated` |
| `auth-spec` | `AUTH-NNN` | `technical/auth/` | `auth-NNN.md` | `draft` · `active` · `deprecated` |
| `test-plan` | `TP-NNN` | `technical/test-plans/` | `tp-NNN.md` | `draft` · `active` · `deprecated` |
| `member` | `MBR-NNN` | `team/members/` | `mbr-NNN.md` | `active` · `draft` |
| `concept` | `CON-NNN` | `concept/{section}/` | `con-NNN.md` | `draft` · `active` · `deprecated` |

`NNN` = zero-padded 3-digit number (001, 002, …). For `concept`, `{section}` ∈ `history` · `goals` · `principles` · `risks` · `sysdesign` · `sysimpl`.

## Key rules

- `type` is strictly enforced — only the 18 exact strings above are valid. Never invent types (`spec`, `technical-spec`, `service-spec`, `auth`, `tech-spec` are all invalid).
- Never change an existing `id` — IDs are immutable.
- `title` must always be in double quotes in the front matter.
- `epicId` is required on every story; `storyId` is required on every task and bug.
- `role` is required on every member; `processType` (`sync` | `async` | `cron`) is required on every `data-proc`; `testScope` (`integration` | `e2e`) is required on every `test-plan`.
- Comma-separated fields (`linkedIds`, `dependsOn`, `relations`) must have no spaces around commas.
- Dates must be `YYYY-MM-DD` only.
