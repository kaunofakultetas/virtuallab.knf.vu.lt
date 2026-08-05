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

variable "guest_ssh_public_key" {
  description = "Dedicated SSH public key installed for root in both containers."
  type        = string

  validation {
    condition     = can(regex("^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) ", trimspace(var.guest_ssh_public_key)))
    error_message = "guest_ssh_public_key must be an OpenSSH public key."
  }
}