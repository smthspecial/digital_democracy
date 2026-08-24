# Entry point wiring the modules below per environment/region. Left empty
# until a cloud provider is chosen (see README.md) -- the module
# boundaries (network, k8s-cluster) are scaffolded so that choice only
# fills in provider-specific resource blocks, not the overall shape.

# module "network" {
#   source = "./modules/network"
#   for_each = toset(var.regions)
#   region   = each.value
# }
#
# module "k8s_cluster" {
#   source = "./modules/k8s-cluster"
#   for_each = toset(var.regions)
#   region   = each.value
#   vpc_id   = module.network[each.value].vpc_id
# }
