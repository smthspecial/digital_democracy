# Coordinated security release

`prepare.py` renders both real runtimes, independent migration Jobs, narrow
migration NetworkPolicies, renewable gateway Certificates and a temporary
gateway mutation deny policy. It does not read secrets or contact a cluster.
Use a confirmed context, owned domain, existing ClusterIssuer and registry
digests in a private copy of `release.example.json`. The example intentionally
cannot deploy. Render with:

```sh
python3 infra/release/prepare.py .release/config.json --output .release/bundle
```

The runtime secret names remain `api-go-runtime` and `api-ts-runtime`; never put
`MIGRATE_DATABASE_URL` in either. Provision separate temporary migration roles
and secrets. The current migrations require role/schema administration; grant
that to the temporary migration identity only and revoke it afterward. Supply
Go migration URLs with `sslmode=verify-full&sslrootcert=/etc/dd/database/ca.crt`.
Prisma migration URLs must use its connector's documented strict TLS options;
verify host/CA rejection with the exact migration image before promotion. The
runtime pg adapter uses `sslmode=verify-full&sslrootcert=...`. Migration Jobs are
outside the mesh to avoid sidecars preventing Job completion; they use direct
database TLS and the explicit database-only NetworkPolicy. That policy also
requires database ingress to allow the migration label/namespace.

Both runtime charts default to APP_ENV=production. Their startup guards reject
development credentials and transport settings. Mount database CA bundles and
workload-specific broker identities; broker keys are readable only inside the
Go pod. No private certificate or secret value belongs in git or an image.

`rollout.py` automates the order below and stops at the first failed check,
keeping gateway maintenance in place. It requires executable, target-specific
`preflight`, `drain`, `verify`, `revoke` and `resume` hooks in a private directory.
Each receives the bundle path. Preflight must establish the approved target and
all independent release evidence; drain must verify actual gateway denial and
stop/drain trusted writers; verify must perform the complete post-rollout checks;
revoke must revoke database roles/terminate migration sessions; resume restarts
compatible trusted writers. A missing hook prevents any cluster operation.
Those hooks require the confirmed deployment inventory and have no permissive
default implementations. Hook output stays in the private bundle directory.
The coordinator verifies the rendered checksum manifest before any operation.
Preflight must bind its approval/evidence to that exact manifest and target;
checksums detect edits, but do not themselves constitute independent approval.

```sh
python3 infra/release/rollout.py .release/bundle --hooks .release/staging-hooks
```

Local sequencing/failure tests qualify the coordinator's stopping behavior;
live Job failures, credential revocation, traffic pauses and rollback still
require staging rehearsal. Readiness alone never authorizes reopening traffic.

Release order, using `kubectl --kubeconfig "$DD_KUBECONFIG" --context "$DD_CONTEXT"`
for every command (never rely on the current context):

1. Verify crypto review, compatible verifier/clients, image gates, backups and
   restore evidence, audited runtime roles, TLS/mesh qualification and owners.
   Snapshot current manifests, schema versions and audit public key. Existing
   audit history requires an explicit continuity/migration decision.
2. Apply `certificates.json`; wait for both Certificates to be Ready. Existing
   Traefik gateway controller and `dd-gateway` GatewayClass, mesh injection and
   enforced CNI must already be healthy. The certificate bundle also creates
   HTTPS-only Gateways in each runtime namespace, restricted to the owned name.
3. Apply `maintenance.json`. Verify mutation denial through the actual gateway
   and stop/drain internal writers, job consumers, verifier/client deployments
   and requests. The generated policy pauses public mutations only; it does not
   drain internal writers. Wait for in-flight work before the ADR-041 cutover.
4. Apply `migrations.json`, wait separately for both named Jobs to Complete and
   inspect sanitized migration evidence. On any failure stop; keep maintenance
   in place. Do not automatically retry or roll back a partially changed schema.
5. Apply the single `runtimes.yaml` bundle, then wait for both Deployments to
   finish rollout. A Kubernetes apply is not an atomic rollout; maintenance
   remains until both runtimes and all other signers are compatible and ready.
   ArgoCD automatic sync is disabled in the checked-in ApplicationSet to prevent
   independent application promotion. Pin the reviewed release revision in
   ArgoCD before any later manual synchronization.
6. Verify readiness, authenticated seams, workload identity/negative probes,
   persistent replay, stable audit public key, RLS, schema compatibility and
   encrypted ballot/tally verification. Revoke migration credentials, terminate
   migration DB sessions and remove the temporary Jobs, policies and secrets.
7. Only after every check passes, delete `maintenance.json` and resume trusted
   writers. Confirm synthetic checks and monitor failures/latency/certificates.

Application rollback uses the recorded compatible image bundle while traffic
remains paused. It does not reverse migrations. Use the rehearsed forward fix
or verified backup restore when schema/data changes are irreversible. Keep
incident ownership and interruption targets in the release inventory.

Production is not ready: complete protocol selection/review, trustee ceremony,
anonymous credentials, encryption/proofs, threshold tally, live infrastructure
qualification and recovery/load evidence in TASK-006 through TASK-021. These
manifests do not constitute that evidence.
