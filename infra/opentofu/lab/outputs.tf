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