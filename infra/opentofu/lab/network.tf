resource "proxmox_sdn_zone_vlan" "lab" {
  id     = "labzone"
  bridge = "vmbr20"
  nodes  = [var.node_name]
}

resource "proxmox_sdn_applier" "lab" {
  lifecycle {
    replace_triggered_by = [proxmox_sdn_zone_vlan.lab]
  }
}