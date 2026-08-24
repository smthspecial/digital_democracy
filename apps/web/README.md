# apps/web

Next.js (App Router, TypeScript) — the citizen-facing web client (ADR-022).
Talks only to the API gateway (ARCH-006) via `@dd/api-client`, never to a
service directly.

```bash
pnpm --filter @dd/web dev
```
