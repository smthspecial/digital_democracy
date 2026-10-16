# Backend application chart

The current ApplicationSet deploys two runtimes from `infra/helm/apps`: `api-go`
and `api-ts` (ADR-027). `infra/helm/values` retains the older per-domain examples;
it is no longer the ApplicationSet input.

```bash
helm lint infra/helm/service -f infra/helm/apps/api-go.yaml
helm template api-go infra/helm/service -f infra/helm/apps/api-go.yaml
```

Install Istio and inject both application namespaces, the trusted verifier, and
the gateway before deploying. The chart requests sidecar injection and supplies
STRICT PeerAuthentication, service-account AuthorizationPolicy, and explicit
namespace/pod/port NetworkPolicy rules. Worker calls must carry a producer header
matching their workload principal. Public ingress permits public reads and the
listed citizen mutations; it cannot invoke internal audit/voting/auth writes.
Policies require a functioning mesh and a NetworkPolicy-capable CNI.

Create `api-go-runtime`/`api-ts-runtime` Secrets with restricted database URLs,
shared signing credentials, and each runtime's required environment. Keep the
stable audit seed only in the Go runtime. Database logins must be separate per
app, with cross-database CONNECT revoked. Use separate jobs/credentials for
migrations. Configure dependency namespace/pod labels to match the actual
Postgres/NATS deployments and use TLS for broker/database connections.

The HTTPS Gateway requires `dd-gateway-tls` in each application namespace.
The trusted verifier must use its configured workload identity and the ADR-041
signature format. Ballot casting stays disabled until a real proof verifier is
configured; arbitrary strings cannot be certified.

ApplicationSet preserves existing resources on application deletion; migrate
older deployments deliberately. These manifests were rendered and inspected,
not applied to a live cluster. See `testing/security/REMEDIATION.md` for evidence.
