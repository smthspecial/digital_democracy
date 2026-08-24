---
applyTo: ".spec/**"
---

# Project Spec — AI Agent Instructions

This workspace uses the **Project Spec** VS Code extension. All project documentation lives in the `.spec/` folder as YAML front-matter markdown files.

## Available language model tools

| Tool | Purpose |
|------|---------|
| `project-spec_get-schema` | Front-matter fields, directory, and body template for a type — call before creating or editing any file |
| `project-spec_read-spec` | Read all spec items across every type |
| `project-spec_query` | Filter spec items by `type` and/or `status` |
| `project-spec_write-file` | Create or overwrite a `.spec/` markdown file |
| `project-spec_validate-file` | Validate a spec file — always run this after `write-file` |

## Creating or editing an item

1. `project-spec_read-spec` or `project-spec_query` to check for duplicates and find the next available ID number.
2. `project-spec_get-schema` for the front-matter fields, directory, and ID convention.
3. `project-spec_write-file` at the workspace-relative path (e.g. `.spec/backlog/epics/epic-004.md`).
4. `project-spec_validate-file` to confirm it's valid.

## TYPE REGISTRY — the only 17 valid document types

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
| `member` | `MBR-NNN` | `team/members/` | `mbr-NNN.md` | `active` · `draft` |
| `concept` | `CON-NNN` | `concept/{section}/` | `con-NNN.md` | `draft` · `active` · `deprecated` |

`NNN` = zero-padded 3-digit number (001, 002, …). For `concept`, `{section}` ∈ `history` · `goals` · `principles` · `risks` · `sysdesign` · `sysimpl`.

## Key rules

- `type` is strictly enforced — only the 17 exact strings above are valid. Never invent types (`spec`, `technical-spec`, `service-spec`, `auth`, `tech-spec` are all invalid).
- Never change an existing `id` — IDs are immutable.
- `title` must always be in double quotes in the front matter.
- `epicId` is required on every story; `storyId` is required on every task and bug.
- `role` is required on every member; `processType` (`sync` | `async` | `cron`) is required on every `data-proc`.
- Comma-separated fields (`linkedIds`, `dependsOn`, `relations`) must have no spaces around commas.
- Dates must be `YYYY-MM-DD` only.
