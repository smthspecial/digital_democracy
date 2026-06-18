# Project Spec — AI Agent Instructions

This workspace uses the **Project Spec** VS Code extension. All project documentation lives in the `.spec/` folder as YAML front-matter markdown files.

## Available language model tools

Use these tools when working in this workspace:

| Tool | Purpose |
|------|---------|
| `project-spec_read-spec` | Read the full project specification (all item types) |
| `project-spec_get-schema` | Get the document schema and authoring guide — call this **before** creating or editing any spec file |
| `project-spec_query` | Filter spec items by `type` and/or `status` |
| `project-spec_write-file` | Create or overwrite a `.spec/` markdown file |
| `project-spec_validate-file` | Validate a spec file after writing |

## Workflow for creating or editing spec items

1. Call `project-spec_get-schema` to get the correct front-matter fields, directory location, and ID conventions for the target type.
2. Call `project-spec_read-spec` or `project-spec_query` to find existing IDs and determine the next available number.
3. Write the file with `project-spec_write-file` using the workspace-relative path (e.g. `.spec/backlog/epics/epic-004.md`).
4. Call `project-spec_validate-file` with the same path to confirm the file is valid.

## Document types and IDs

| Type | ID prefix | Directory |
|------|-----------|-----------|
| `fr` | `FR-` | `.spec/requirements/functional/` |
| `nfr` | `NFR-` | `.spec/requirements/non-functional/` |
| `epic` | `EPIC-` | `.spec/backlog/epics/` |
| `story` | `US-` | `.spec/backlog/stories/` |
| `task` | `TASK-` | `.spec/backlog/tasks/` |
| `bug` | `BUG-` | `.spec/backlog/bugs/` |
| `sprint` | `SPRINT-` | `.spec/sprints-releases/sprints/` |
| `release` | `REL-` | `.spec/sprints-releases/releases/` |
| `adr` | `ADR-` | `.spec/technical/adr/` |
| `arch` | `ARCH-` | `.spec/technical/arch-docs/` |
| `tech-spec` | `TECH-` | `.spec/technical/tech-specs/` |
| `cicd` | `CICD-` | `.spec/technical/cicd/` |
| `auth-spec` | `AUTH-` | `.spec/technical/auth-specs/` |
| `db-table` | `DB-` | `.spec/database/` |
| `member` | `MBR-` | `.spec/team/` |

## Key rules

- **Never** change an existing `id` field — IDs are immutable.
- `title` must be quoted in front matter.
- `epicId` is required on stories; `storyId` is required on tasks and bugs.
- `role` is required on team members.
- Valid statuses differ by type — call `project-spec_get-schema` for details.
