---
id: TASK-016
type: task
title: "Retire or explicitly maintain the three patched dependencies"
status: in-progress
storyId: US-057
priority: high
dependsOn: TASK-006
linkedIds: REL-002,BUG-012,NFR-007
created: 2026-10-08
---

## Outcome

Each patched dependency has a verified upgrade/removal path or a narrowly maintained mitigation with a review deadline.

## Responsible role

Dependency/application maintainer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Use pnpm why and deployed bundle inspection for node-forge, braces and sprintf-js; classify production, mobile, build and test exposure.
- [ ] Upgrade parent dependencies or replace avoidable consumers when compatible maintained alternatives remove the advisory. Recheck upstream releases when implementing; no guessed safe versions.
- [ ] For any remaining patch, record exact advisory/version, patch hash, exploit test, owner and next review date. Bound exceptions to those exact entries; reject unexpected advisories.
- [ ] Run positive behavior and exploit regressions against every resolved copy and the packaged runtime artifacts; verify frozen-lockfile installs reproduce the patch.
- [ ] Remove each exception only after its consumer is removed or a verified upstream fix passes. Keep raw scanner evidence; do not suppress notices merely to obtain a clean-looking report.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.

## Mobile dependency checkpoint — 2026-10-14

Fresh Android/iOS Metro exports pass module-inventory inspection in both default
Hermes bytecode and JavaScript modes. None includes node-forge, braces or
sprintf-js. Reports retain exact bundle/source-map digests and the lockfile hash:
[Hermes](../../../testing/production-readiness/mobile-hermes-bundle-results.json),
[JavaScript](../../../testing/production-readiness/mobile-javascript-bundle-results.json).
This qualifies the current placeholder client's exported JavaScript modules;
signed APK/IPA/native dependency qualification and mobile-web support remain
outside these checks. The mobile app currently has no react-native-web dependency.

The regression runner discovers every active resolved copy through `pnpm why`,
checks its exact version/applied patch hash and runs all ten exploit/positive
controls. Unreferenced stale pnpm-store directories are not active copies.
CI exports both native platforms and rejects patched-package inclusion, missing
inventories/maps and escaped paths; it retains the digest report.

Upstream registry/advisory rechecks still report no fixed release for these
three advisories. Existing patches, ownership roles and 2026-11-07 expiry remain
unchanged. See [current dependency review](../../../testing/production-readiness/dependency-review-20261014.json).
Removing Expo/Metro/React Native to eliminate their build dependencies would
change ADR-022's client architecture; no such change is made. Named production
maintenance ownership and final packaged-artifact qualification stay open.
