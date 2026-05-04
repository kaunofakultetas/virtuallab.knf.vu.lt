# Environment Setup

Setup Proxmox.

## 1. Networking Configuration

Navigate to: `Datacenter` -> `Node` -> `System` -> `Network`.

### 1.1 Virtual Bridge for management (vmbr1)

Create a Linux Bridge with the following configuration:
- Bridge name: `vmbr1`
- IPv4/CIDR: `10.10.10.1/24`
- Autostart: enabled
- Comment: `management bridge`

Click "Apply Configuration".

Enable DCHP for vmbr1 by running the following commands on the proxmox host shell:
```sh
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
### 1.2 Virtual Bridge for lab VMs (vmbr20)

Create a Linux Bridge with the following configuration:
- Bridge name: `vmbr20`
- IPv4/CIDR: `10.10.20.1/24`
- Autostart: enabled
- Comment: `lab vm bridge`

Click "Apply Configuration".

Enable DCHP for vmbr20 by running the following commands on the proxmox host shell:
```sh
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

## 2. Setup Guacamole VM

Refer [here](./infra/guacamole/README.md) for the Guacamole VM setup instructions.

## 3. Create build and template images

Refer [here](./templates/README.md) for the build and template image creation instructions.

## 4. Boot up the Backend

Coming soon!
