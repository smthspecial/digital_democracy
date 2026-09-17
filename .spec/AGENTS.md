# Project Spec — Agent Instructions

All project documentation lives in the `.spec/` folder as YAML front-matter Markdown files, managed by the **Project Spec** VS Code extension. There's no special tool or server for reading or writing them — use your normal file tools directly, following the schema below.

## Creating or editing an item

1. Find the type's front-matter fields, directory, file name, and valid statuses in the type registry below.
2. Search the `.spec/` directory for existing items of that type to find the next available ID and check for duplicates.
3. Write the file at its workspace-relative path, e.g. `.spec/backlog/epics/epic-004.md`, matching the front-matter and body conventions of existing files of that type.
4. Check the front matter against the rules below by hand before considering it done — there's no separate validation tool.

## TYPE REGISTRY — the only 18 valid document types

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
| `arch` | `ARCH-NNN` | `technical/architecture/` | `arch-NNN.md` | `draft` · `active` · `deprecated` |
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
- `role` is required on every member; `processType` (`sync` | `async` | `cron`) is required on every `data-proc`.
- `testScope` (`unit` · `integration` · `e2e`) is required on every `test-plan`.
- Comma-separated fields (`linkedIds`, `dependsOn`, `relations`) must have no spaces around commas.
- Dates must be `YYYY-MM-DD` only.
- To mark a document historical without deleting it (e.g. one written against a topology a later ADR replaced), set its `status` to `deprecated` (or `superseded` for an `adr` specifically) rather than editing its body to match current reality — the doc's content should still reflect what was true when it was written.
