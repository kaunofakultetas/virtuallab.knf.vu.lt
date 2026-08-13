output "guacamole" {
  description = "Guacamole LXC connection details."
  value = {
    vm_id          = proxmox_virtual_environment_container.guacamole.vm_id
    management_ip  = "10.10.10.50"
    lab_network_ip = "10.10.20.10"
  }
}

output "api_docker" {
  description = "Application LXC connection details."
  value = {
    vm_id         = proxmox_virtual_environment_container.api_docker.vm_id
    management_ip = "10.10.10.100"
  }
}

output "gateway" {
  description = <<-EOT
    Stopped Gateway VM shell. Its uplink shares an L2 broadcast domain with
    Proxmox management, which is an accepted deviation recorded in
    NETWORK-ARCHITECTURE-PLAN.md; the guest firewall exposes no service there.
  EOT
  value = {
    vm_id         = proxmox_virtual_environment_vm.gateway.vm_id
    management_ip = "10.10.10.2"
    uplink_bridge = "vmbr0"
    uplink_ip     = "172.16.0.36/22"
    trunk_bridge  = "vmbr20"
    started       = proxmox_virtual_environment_vm.gateway.started
  }
}

output "lab_sdn_zone" {
  description = "Persistent VLAN SDN zone used by backend-managed lab VNets."
  value = {
    id     = proxmox_sdn_zone_vlan.lab.id
    bridge = "vmbr20"
  }
}