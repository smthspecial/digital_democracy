# Terraform (skeleton)

This directory is scaffolded but intentionally does not commit to a cloud
provider yet -- ADR-017 requires 3+ independent regions/data centers but
does not name AWS/GCP/Azure/on-prem, and that is a real open decision,
not an oversight. `versions.tf`, `variables.tf`, and `main.tf` sketch the
module boundaries (`network`, `k8s-cluster`) that ARCH-006's topology
implies; each module's `README.md` is where the provider-specific
resources go once that decision is made. Do not add a provider block
speculatively -- pick it deliberately (likely worth its own ADR) and fill
these modules in as part of that work.
