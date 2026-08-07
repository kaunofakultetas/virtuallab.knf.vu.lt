resource "proxmox_download_file" "ubuntu_noble_gateway" {
  content_type       = "import"
  datastore_id       = var.template_datastore_id
  node_name          = var.node_name
  url                = var.gateway_image_url
  checksum           = var.gateway_image_sha256
  checksum_algorithm = "sha256"
  file_name          = "ubuntu-24.04-server-cloudimg-amd64-20260801.qcow2"
  overwrite          = false
}

resource "proxmox_virtual_environment_vm" "gateway" {
  description = "Lab policy gateway shell. Routing and policy services are not yet configured."
  name        = "lab-gateway"
  node_name   = var.node_name
  vm_id       = 202

  started = false
  on_boot = false

  agent {
    wait_for_ip {
      disabled = true
    }
  }

  tags = ["gateway", "infra", "opentofu", "staged"]

  cpu {
    cores = 2
    type  = "x86-64-v2-AES"
  }

  memory {
    dedicated = 4096
  }

  disk {
    datastore_id = var.root_datastore_id
    import_from  = proxmox_download_file.ubuntu_noble_gateway.id
    interface    = "scsi0"
    iothread     = true
    discard      = "on"
    size         = 16
  }

  initialization {
    datastore_id = var.root_datastore_id
    upgrade      = false

    ip_config {
      ipv4 {
        address = "10.10.10.2/24"
      }
    }

    user_account {
      username = "gateway-admin"
      keys     = [trimspace(var.guest_ssh_public_key)]
    }
  }

  network_device = [
    {
      bridge       = "vmbr1"
      disconnected = false
      enabled      = true
      firewall     = true
      mac_address  = ""
      model        = "virtio"
      mtu          = 0
      queues       = 0
      rate_limit   = 0
      trunks       = ""
      vlan_id      = 0
    },
    {
      bridge       = "vmbr20"
      disconnected = false
      enabled      = true
      firewall     = true
      mac_address  = ""
      model        = "virtio"
      mtu          = 0
      queues       = 0
      rate_limit   = 0
      trunks       = join(";", [for vlan_id in range(2000, 2256) : tostring(vlan_id)])
      vlan_id      = 0
    },
  ]

  operating_system {
    type = "l26"
  }

  scsi_hardware = "virtio-scsi-single"
}