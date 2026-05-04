# Templates

This contains documentation on how to prepare images for the system.

## 1. Creating a build image

Create a new VM with desired ISO. (for network use vmbr1)
Install OS, set up the environment as desired.

Install and enable SSH, RDP on the machine.

The build image can be modified later (updated, new tools added, etc.).

These images should have id's in the 100's and be tagged with 'build_image':
```sh
qm set (build_vm_id) --tags build_image
qm set 100 --tags build_image
```

## 2. Create a template image

### 2.1. Clone the build image 

If an old template image exists, delete it (`qm destroy 9000`)
Template images should have the id's in the 9000's and be tagged with 'template_image'.

Clone the build image and tag it as a template image:
```sh
qm clone (build_vm_id) (template_vm_id) --name (name) --full=1
qm set (template_vm_id) --tags template_image

qm clone 100 9000 --name attacker-kali-template --full=1
qm set 9000 --tags template_image
```

### 2.2. Cleanup & create template

Power on the template image.

Run cleanup commands, they are provided in `cleanup_vm.sh`.

After cleanup and shutdown, run in the proxmox host shell:
```sh
# Add cloud-init drive + agent + serial console to the clone-that-becomes-template
qm set 9000 --ide2 local-lvm:cloudinit
qm set 9000 --boot order=scsi0
qm set 9000 --serial0 socket --vga std
qm set 9000 --agent enabled=1

# Convert to template
qm template 9000

# Test by cloning once
qm clone 9000 9101 --name test-clone --full=0
qm set 9101 --ciuser user --cipassword 'password' \
            --ipconfig0 ip=dhcp \
            --net0 virtio,bridge=vmbr20,firewall=1 \
            --tags test_clone
qm start 9101

# Wait ~30s, then ask the guest agent for the IP
qm guest cmd 9101 network-get-interfaces

# cleanup
qm stop 9101 && qm destroy 9101
```
