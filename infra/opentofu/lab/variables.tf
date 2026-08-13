variable "proxmox_endpoint" {
  description = "HTTPS URL of the Proxmox API, including port 8006."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+:8006/?$", var.proxmox_endpoint))
    error_message = "proxmox_endpoint must be an HTTPS URL using port 8006."
  }
}

variable "proxmox_api_token" {
  description = "Proxmox API token in user@realm!token=secret format."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@]+@[^!]+![^=]+=.+$", var.proxmox_api_token))
    error_message = "proxmox_api_token must use user@realm!token=secret format."
  }
}

variable "proxmox_insecure" {
  description = "Allow the Proxmox provider to use an untrusted TLS certificate."
  type        = bool
  default     = false
}

variable "node_name" {
  description = "Proxmox node that will host the template and containers."
  type        = string

  validation {
    condition     = length(trimspace(var.node_name)) > 0
    error_message = "node_name must not be empty."
  }
}

variable "template_datastore_id" {
  description = "Proxmox datastore for LXC templates."
  type        = string
  default     = "local"
}

variable "root_datastore_id" {
  description = "Proxmox datastore for LXC root filesystems."
  type        = string
  default     = "local-lvm"
}

variable "ubuntu_template_url" {
  description = "URL for the checksum-pinned Ubuntu 22.04 amd64 Proxmox LXC template."
  type        = string
  default     = "http://download.proxmox.com/images/system/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"

  validation {
    condition     = can(regex("^https?://.+\\.tar\\.zst$", var.ubuntu_template_url))
    error_message = "ubuntu_template_url must be an HTTP(S) URL for a .tar.zst LXC template."
  }
}

variable "ubuntu_template_sha512" {
  description = "SHA-512 checksum published for ubuntu_template_url."
  type        = string
  default     = "cf617c11232c3fbce1ba9f7146ac194561411c292c445b2a5c9affe5f09729f5c38315619de4d649ff63e31dd5b536ea081fdde1b7792e6e521d1694ac7c9cb8"

  validation {
    condition     = can(regex("^[0-9a-f]{128}$", var.ubuntu_template_sha512))
    error_message = "ubuntu_template_sha512 must be a lowercase SHA-512 digest."
  }
}

variable "gateway_image_url" {
  description = "Immutable URL for the Ubuntu 24.04 amd64 cloud image used by Gateway VM 202."
  type        = string
  default     = "https://cloud-images.ubuntu.com/releases/noble/release-20260801/ubuntu-24.04-server-cloudimg-amd64.img"

  validation {
    condition     = can(regex("^https://.+\\.img$", var.gateway_image_url))
    error_message = "gateway_image_url must be an HTTPS URL for an .img cloud image."
  }
}

variable "gateway_image_sha256" {
  description = "SHA-256 checksum published for gateway_image_url."
  type        = string
  default     = "0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe"

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.gateway_image_sha256))
    error_message = "gateway_image_sha256 must be a lowercase SHA-256 digest."
  }
}

variable "guest_ssh_public_key" {
  description = "Dedicated SSH public key installed for root in both containers."
  type        = string

  validation {
    condition     = can(regex("^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) ", trimspace(var.guest_ssh_public_key)))
    error_message = "guest_ssh_public_key must be an OpenSSH public key."
  }
}
variable "gateway_bootstrap_mode" {
  description = <<-EOT
    Prepares VM 202 for its first boot, before any firewall exists on the guest.

    When true the uplink NIC is left disconnected and the default route runs
    through the management network, where the Proxmox host already NATs
    10.10.10.0/24 out vmbr0. The Gateway can then install packages and receive
    its rendered policy without ever sitting unprotected on the campus segment
    that the uplink shares with Proxmox management.

    Set back to false once the guest policy is applied and verified; that
    connects the uplink and moves the default route onto it.
  EOT
  type        = bool
  default     = false
}

variable "gateway_started" {
  description = <<-EOT
    Power state for VM 202, declared here so a manually started guest does not
    drift back to stopped on the next apply.

    Keep false until the guest's fail-closed nftables, DHCP, DNS, and proxy
    configuration has been applied and verified. Start it only together with
    gateway_bootstrap_mode = true, so its first boot happens with the uplink
    disconnected.
  EOT
  type        = bool
  default     = false
}

variable "additional_guest_ssh_public_keys" {
  description = <<-EOT
    Extra public keys authorised on the Gateway, alongside the deployment key.

    The Proxmox host's key belongs here: 10.10.10.0/24 is reachable only from the
    host and the LXCs, so the host is the control point for guest configuration.
    This grants no privilege the host lacks, since host root already controls the
    VM through qm and its disk.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for key in var.additional_guest_ssh_public_keys :
      can(regex("^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) ", trimspace(key)))
    ])
    error_message = "Each entry must be an OpenSSH public key."
  }
}
