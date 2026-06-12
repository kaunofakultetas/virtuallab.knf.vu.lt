---
slug: /setup
title: Setup
description: How to set up the project
---

# Setup

This section will guide you through the process of setting up the project.

## Prerequisites

Before you begin, make sure you have a Proxmox VE environment set up and running. You will also need to have access to the Proxmox API.

## Installation

### Networking Configuration

Navigate to: `Datacenter` -> `Node` -> `System` -> `Network`.

#### Virtual Bridge for management (vmbr1)

Create a Linux Bridge with the following configuration:
- Bridge name: `vmbr1`
- IPv4/CIDR: `10.10.10.1/24`
- Autostart: enabled
- Comment: `management bridge`

Click "Apply Configuration".

Enable DHCP for vmbr1 by running the following commands on the proxmox host shell:
```bash
sudo apt install -y dnsmasq
sudo tee /etc/dnsmasq.d/vmbr1.conf <<'EOF'
interface=vmbr1
bind-interfaces
dhcp-range=10.10.10.50,10.10.10.200,12h
dhcp-option=3,10.10.10.1
dhcp-option=6,1.1.1.1,8.8.8.8
EOF
sudo systemctl restart dnsmasq
```
#### Virtual Bridge for lab VMs (vmbr20)

Create a Linux Bridge with the following configuration:
- Bridge name: `vmbr20`
- IPv4/CIDR: `10.10.20.1/24`
- Autostart: enabled
- Comment: `lab vm bridge`

Click "Apply Configuration".

Enable DHCP for vmbr20 by running the following commands on the proxmox host shell:
```bash
apt install -y dnsmasq
cat >/etc/dnsmasq.d/vmbr20.conf <<'EOF'
interface=vmbr20
bind-interfaces
dhcp-range=10.10.20.50,10.10.20.200,12h
dhcp-option=3,10.10.20.1
dhcp-option=6,1.1.1.1,8.8.8.8
EOF
systemctl restart dnsmasq
```

### Setup Guacamole VM

Refer here for the Guacamole VM setup instructions.

### Create build and template images

Refer here for the build and template image creation instructions.

### Boot up the Backend

In Proxmox create a container with the ID 201. Install Ubuntu.
Set static ip 10.10.10.100/24. Add NAT and forward 80, 443, 2222->22 ports to the VM.
Clone the repository, run `./runUpdateThisStack.sh`.
