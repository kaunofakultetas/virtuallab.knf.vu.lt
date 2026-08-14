resource "proxmox_download_file" "ubuntu_jammy_lxc" {
  content_type       = "vztmpl"
  datastore_id       = var.template_datastore_id
  node_name          = var.node_name
  url                = var.ubuntu_template_url
  checksum           = var.ubuntu_template_sha512
  checksum_algorithm = "sha512"
  overwrite          = false
}

resource "proxmox_virtual_environment_container" "guacamole" {
  description = "Guacamole and its dynamic web proxy. Managed by OpenTofu."
  node_name   = var.node_name
  vm_id       = 200

  unprivileged  = true
  started       = true
  start_on_boot = true

  tags = ["infra", "guacamole", "opentofu"]

  features {
    nesting = true
  }

  cpu {
    cores = 4
  }

  memory {
    dedicated = 10240
    swap      = 512
  }

  disk {
    datastore_id = var.root_datastore_id
    size         = 32
  }

  operating_system {
    template_file_id = proxmox_download_file.ubuntu_jammy_lxc.id
    type             = "ubuntu"
  }

  initialization {
    hostname = "guacamole"

    dns {
      servers = ["1.1.1.1", "8.8.8.8"]
    }

    ip_config {
      ipv4 {
        address = "10.10.10.50/24"
        gateway = "10.10.10.1"
      }
    }

    # Lab-side transport. Addresses live on in-guest eth1.<vlan> subinterfaces
    # written by the Access applier, so the parent NIC deliberately carries
    # none: an untagged address here fails the required `access-transport-mode`
    # readiness check and blocks active mode.
    ip_config {}

    user_account {
      keys = [trimspace(var.guest_ssh_public_key)]
    }
  }

  network_interface {
    bridge = "vmbr1"
    name   = "eth0"
  }

  network_interface {
    bridge = "vmbr20"
    name   = "eth1"
  }

  startup {
    order      = "1"
    up_delay   = "15"
    down_delay = "30"
  }
}

resource "proxmox_virtual_environment_container" "api_docker" {
  description = "API, frontend, PostgreSQL, docs, proxies, and logging. Managed by OpenTofu."
  node_name   = var.node_name
  vm_id       = 201

  unprivileged  = true
  started       = true
  start_on_boot = true

  tags = ["api", "infra", "opentofu", "virtual-lab"]

  features {
    nesting = true
  }

  cpu {
    cores = 4
  }

  memory {
    dedicated = 6144
    swap      = 1024
  }

  disk {
    datastore_id = var.root_datastore_id
    size         = 32
  }

  operating_system {
    template_file_id = proxmox_download_file.ubuntu_jammy_lxc.id
    type             = "ubuntu"
  }

  initialization {
    hostname = "api-docker"

    dns {
      servers = ["1.1.1.1", "8.8.8.8"]
    }

    ip_config {
      ipv4 {
        address = "10.10.10.100/24"
        gateway = "10.10.10.1"
      }
    }

    user_account {
      keys = [trimspace(var.guest_ssh_public_key)]
    }
  }

  network_interface {
    bridge = "vmbr1"
    name   = "eth0"
  }

  startup {
    order      = "2"
    up_delay   = "15"
    down_delay = "30"
  }
}