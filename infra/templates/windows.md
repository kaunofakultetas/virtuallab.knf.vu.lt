# Windows Template Guide

Windows templates require two extras compared to Linux:
- **VirtIO drivers** — for paravirtualised disk and network performance.
- **cloudbase-init** — the Windows equivalent of cloud-init; lets Proxmox set the hostname, credentials, and IP on each clone.

## 1. Download required ISOs

On the Proxmox host:
```sh
cd /var/lib/vz/template/iso

# VirtIO drivers ISO (stable build)
wget https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso
```

Upload your Windows ISO to Proxmox via the web UI (Datacenter → local storage → ISO Images → Upload).

## 2. Create a build VM

```sh
qm create 101 --name windows-build \
  --memory 8192 --cores 4 \
  --net0 virtio,bridge=vmbr1,firewall=1 \
  --scsihw virtio-scsi-single \
  --agent enabled=1 \
  --vga std \
  --tags build_image

# Attach Windows ISO as primary boot drive
qm set 101 --cdrom local:iso/windows.iso

# Create and attach disk
qm set 101 --scsi0 local-lvm:60

# Attach VirtIO drivers ISO as second CD
qm set 101 --ide0 local:iso/virtio-win.iso

qm set 101 --boot order='cdrom;scsi0'
```

## 3. Install Windows

Start the VM and open the console:
```sh
qm start 101
```

During installation, when asked where to install, click **Load driver** → browse the VirtIO ISO → `amd64\w11` (or `w10`, `2k22`, etc.) → load the **VirtIO SCSI** driver so the disk is visible.

Complete the Windows installation normally.

## 4. Install VirtIO drivers and guest agent

After Windows boots, open the VirtIO ISO in File Explorer and run:

- `virtio-win-guest-tools.exe` — installs all drivers (network, balloon, etc.) and the QEMU guest agent in one step.

Verify the guest agent is running:
```powershell
Get-Service QEMU-GA
```

## 5. Install cloudbase-init

cloudbase-init applies cloud-init data (credentials, IP config) on first boot of each clone.

Download and run the installer from the [cloudbase-init releases page](https://cloudbase.it/cloudbase-init/).

During installation:
- Set username to `user` (must match what the backend sends as `ciuser`).
- Check **Run Sysprep** — leave it **unchecked**; the cleanup script handles generalization.

After install, edit `C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf\cloudbase-init.conf`:
```ini
[DEFAULT]
username=user
groups=Administrators
inject_user_password=true
config_drive_raw_hhd=true
config_drive_cdrom=true
config_drive_vfat=true
first_logon_behaviour=no
metadata_services=cloudbaseinit.metadata.services.configdrive.ConfigDriveService
plugins=cloudbaseinit.plugins.common.sethostname.SetHostNamePlugin,
        cloudbaseinit.plugins.windows.createuser.CreateUserPlugin,
        cloudbaseinit.plugins.common.setuserpassword.SetUserPasswordPlugin,
        cloudbaseinit.plugins.windows.networkconfig.NetworkConfigPlugin
```

## 6. Enable RDP & SSH

```powershell
# Enable RDP
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0

# Allow RDP through the firewall
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"

# Allow connections from any version (not NLA-only) — required for Guacamole
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -Value 0

# Install OpenSSH Server (built into Windows 10 1809+ / Server 2019+ as a Feature on Demand)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Start the service and set it to auto-start on boot
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# Firewall rule (the installer usually creates this, but verify)
if (!(Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
}
```

## 7. Set up the environment

Install any tools, configure the OS, run Windows Update, etc.
The build image can be modified freely at any time before cloning to a template.

Tag the build VM once it is ready:
```sh
qm set 101 --tags build_image
```

## 8. Create a template image

### 8.1. Clone the build VM

If an old template exists, destroy it first:
```sh
qm destroy 9001
```

Clone the build VM:
```sh
qm clone 101 9001 --name windows-template --full=1
qm set 9001 --tags template_image
```

### 8.2. Run the cleanup script

Copy `windows_cleanup.ps1` to the clone and run it as Administrator:
```powershell
# From the Proxmox host, copy via SMB or use the Proxmox file transfer
# Then inside the VM, run:
Set-ExecutionPolicy Bypass -Scope Process -Force
.\windows_cleanup.ps1
```

The script clears logs, temp files, and cloudbase-init state, then runs Sysprep to generalize the image and shuts the VM down. **Wait for it to power off completely before proceeding.**

### 8.3. Configure and convert to template

Run on the Proxmox host after the VM has shut down:
```sh
# Remove the Windows and VirtIO ISOs (if not done already)
qm set 9001 --delete cdrom,ide0

# Add cloud-init drive and ensure guest agent is enabled
qm set 9001 --ide2 local-lvm:cloudinit
qm set 9001 --boot order=scsi0
qm set 9001 --agent enabled=1

# Convert to template (irreversible)
qm template 9001
```

### 8.4. Register in the web UI

Go to the admin panel → Templates → Add template. Set the Proxmox VM ID to `9001`.

## 9. Test the template

```sh
qm clone 9001 9102 --name test-win-clone --full=0
qm set 9102 \
  --ciuser user --cipassword 'Password123!' \
  --ipconfig0 ip=dhcp \
  --net0 virtio,bridge=vmbr20,firewall=1 \
  --tags test_clone
qm start 9102

# Wait ~60s for cloudbase-init to finish, then check the guest agent
qm guest cmd 9102 network-get-interfaces

# Cleanup
qm stop 9102 && qm destroy 9102
```
