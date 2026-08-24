variable "regions" {
  description = "The 3+ independent regions ADR-017 requires for active-active deployment."
  type        = list(string)
  default     = []
}

variable "environment" {
  description = "Deployment environment name (dev | staging | prod)."
  type        = string
}
