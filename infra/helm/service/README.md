# `service` chart

One generic Helm chart deploys every backend service (ADR-015, ARCH-006) --
Deployment, Service, HorizontalPodAutoscaler, PodDisruptionBudget,
ServiceAccount, NetworkPolicy, and (if `route.prefix` is set) a Gateway API
HTTPRoute. There is no
per-service chart directory: 17 near-identical `Chart.yaml`/`templates/`
trees would be duplication with no behavioral difference between them,
so instead each service gets one small values file.

Deploy a service:

```bash
helm upgrade --install voting-service infra/helm/service \
  -f infra/helm/values/voting-service.yaml \
  -n voting-service --create-namespace
```

In practice this is done for every service at once by the ArgoCD
`ApplicationSet` in `infra/argocd/applicationset.yaml`, which iterates
`infra/helm/values/*.yaml` and creates one Argo Application per file.
