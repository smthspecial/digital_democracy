# apps/mobile

Expo (React Native, TypeScript) — the citizen-facing mobile client
(ADR-022), for the same API surface as `apps/web` via `@dd/api-client`.
Managed workflow (not ejected) — see ADR-022 for why Expo over bare RN.

```bash
pnpm --filter @dd/mobile dev
```

Requires the Expo Go app (or a simulator) to run during development; see
the [Expo docs](https://docs.expo.dev/get-started/set-up-your-environment/).
