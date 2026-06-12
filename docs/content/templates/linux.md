---
slug: /templates/linux
title: Linux
description: Linux template creation guide.
---

# Linux Template Guide

## Create a build image

Create a new VM with the desired ISO. Use `vmbr1` for network during installation.

Install the OS and set up the environment (tools, users, configuration) as desired.
The build image can be updated and modified freely at any time.

Install and enable SSH and RDP on the machine — both are required by the system:
```bash
# SSH
sudo apt install -y openssh-server
sudo systemctl enable --now ssh

# RDP (xrdp)
sudo apt install -y xrdp
sudo systemctl enable --now xrdp
```

Tag the build image:
```bash
qm set <build_vm_id> --tags build_image
# e.g.
qm set 100 --tags build_image
```

## Create a template image

### Clone the build image

Template images should have IDs in the 9000s. If an old template exists, destroy it first:
```bash
qm destroy 9000
```

Clone the build image:
```bash
qm clone <build_vm_id> <template_vm_id> --name <name> --full=1
qm set <template_vm_id> --tags template_image
# e.g.
qm clone 100 9000 --name kali-template --full=1
qm set 9000 --tags template_image
```

### Run the cleanup script

Power on the clone, copy [linux_cleanup.sh](https://github.com/kaunofakultetas/virtuallab.knf.vu.lt/blob/main/infra/templates/linux_cleanup.sh) onto it, and run it:
```bash
scp linux_cleanup.sh user@<vm-ip>:~
ssh user@<vm-ip> "bash ~/linux_cleanup.sh"
```

The script clears cloud-init state, SSH host keys, machine-id, logs, package cache, and shell history, then powers off the VM. **Do not reboot — wait for it to shut down cleanly.**

> See also: [Windows template guide](/templates/windows) for the matching cleanup flow on Windows images.

### Configure and convert to template

Run on the Proxmox host after the VM has shut down:
```bash
# Add cloud-init drive, guest agent, serial console
qm set 9000 --ide2 local-lvm:cloudinit
qm set 9000 --boot order=scsi0
qm set 9000 --serial0 socket --vga serial0
qm set 9000 --agent enabled=1

# Convert to template (irreversible)
qm template 9000
```

### Register in the web UI

Go to the admin panel → Templates → Add template. Set the Proxmox VM ID to `9000`.

## Test the template

```bash
qm clone 9000 9101 --name test-clone --full=0
qm set 9101 \
  --ciuser user --cipassword 'password' \
  --ipconfig0 ip=dhcp \
  --net0 virtio,bridge=vmbr20,firewall=1 \
  --tags test_clone
qm start 9101

# Wait ~30s, then verify the guest agent responds
qm guest cmd 9101 network-get-interfaces

# Cleanup
qm stop 9101 && qm destroy 9101
```
