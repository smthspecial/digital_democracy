terraform {
  required_version = ">= 1.7"

  # Cloud provider is not yet chosen (ADR-017 specifies multi-region
  # active-active but is deliberately provider-agnostic; see
  # infra/terraform/README.md). Add the provider block here once decided,
  # e.g.:
  #
  # required_providers {
  #   aws = {
  #     source  = "hashicorp/aws"
  #     version = "~> 5.0"
  #   }
  # }
}
