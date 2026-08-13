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

  started = var.gateway_started
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

    # Guest OS resolution only. The host's dnsmasq on vmbr1 is directly
    # connected in both bootstrap and normal mode, so this stays reachable
    # regardless of where the default route points. Squid and the Gateway's own
    # dnsmasq use the upstream resolvers from settings.network.gateway.*
    # instead, and are unaffected by this.
    dns {
      servers = ["10.10.10.1"]
    }

    # ip_config blocks map positionally to network_device entries, so the trunk
    # NIC needs an explicit empty block to keep the uplink aligned with net2.

    # net0: management, reached by the orchestrator over vmbr1. During bootstrap
    # this also carries the default route, because the Proxmox host already NATs
    # 10.10.10.0/24 out vmbr0, letting the guest install packages while its
    # uplink stays disconnected.
    ip_config {
      ipv4 {
        address = "10.10.10.2/24"
        gateway = var.gateway_bootstrap_mode ? "10.10.10.1" : null
      }
    }

    # net1: VLAN trunk. Addresses live on in-guest eth.<vlan> subinterfaces, so
    # the parent NIC deliberately carries none.
    ip_config {}

    # net2: approved-egress uplink. Outside bootstrap this is the Gateway's
    # default route and the source address Squid and the resolver leave from.
    # Exactly one default route may exist, so the gateway moves here only once
    # bootstrap is finished.
    ip_config {
      ipv4 {
        address = "172.16.0.36/22"
        gateway = var.gateway_bootstrap_mode ? null : "172.16.0.1"
      }
    }

    user_account {
      username = "gateway-admin"
      keys = distinct(concat(
        [trimspace(var.guest_ssh_public_key)],
        [for key in var.additional_guest_ssh_public_keys : trimspace(key)],
      ))
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
    # Approved-egress uplink. This shares an L2 broadcast domain with Proxmox
    # management, which is an explicitly accepted deviation recorded in
    # NETWORK-ARCHITECTURE-PLAN.md: the host has one physical NIC, and packet
    # capture proved the second adapter lands on the same segment. The guest
    # firewall therefore exposes no service on this NIC.
    {
      bridge = "vmbr0"
      # Left disconnected during bootstrap so the guest is never on the campus
      # segment before its nftables policy exists.
      disconnected = var.gateway_bootstrap_mode
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
  ]

  operating_system {
    type = "l26"
  }

  scsi_hardware = "virtio-scsi-single"
}