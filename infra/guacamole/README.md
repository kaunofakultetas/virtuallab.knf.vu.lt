## 1. Download Ubuntu cloud iso (if not downloaded)

On Proxmox host:
```sh
cd /var/lib/vz/template/iso
wget https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img
```

## 2. Create Guacamole VM

```sh
qm create 200 --name guacamole \
  --memory 4096 --cores 2 \
  --net0 virtio,bridge=vmbr1,firewall=1 \
  --scsihw virtio-scsi-single \
  --agent enabled=1 \
  --serial0 socket --vga serial0 \
  --tags infra,guacamole

qm importdisk 200 /var/lib/vz/template/iso/jammy-server-cloudimg-amd64.img local-lvm
qm set 200 --scsi0 local-lvm:vm-200-disk-0
qm resize 200 scsi0 +30G
qm set 200 --ide2 local-lvm:cloudinit
qm set 200 --boot order=scsi0
```

# 3. Configure cloud-init

```sh
qm set 200 \
  --ciuser ubuntu \
  --cipassword 'TempPassword123!' \
  --ipconfig0 ip=dhcp \
  --sshkeys ~/.ssh/authorized_keys \
  --cicustom "vendor=local:snippets/guac-init.yaml"

qm start 200
```

You'll need to create `/var/lib/vz/snippets/guac-init.yaml` on the host (Datacenter → local storage → Snippets — enable "Snippets" content type if not already):
```yaml
#cloud-config
package_update: true
package_upgrade: false
packages:
  - qemu-guest-agent
  - docker.io
  - docker-compose-v2
runcmd:
  - systemctl enable --now qemu-guest-agent docker
  - usermod -aG docker ubuntu
```

# 4. Start

```sh
qm start 200

# Wait ~60s, then get its IP
qm guest cmd 200 network-get-interfaces | grep "ip-address"
```

# 5. Setup the stack

```sh
ssh ubuntu@<guac-vm-ip>

mkdir guacamole && cd guacamole
cat > compose.yaml <<'EOF'
services:
  guacamole:
    image: abesnier/guacamole:latest
    container_name: guacamole
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./data:/config
EOF

docker compose up -d
docker compose logs -f
```

# 6. Attach vmbr20 to Guacamole VM

```sh
qm set 200 --net1 virtio,bridge=vmbr20,firewall=1
qm set 200 --ipconfig1 ip=10.10.20.10/24
qm reboot 200
```

# 7. Config Guacamole

```sh
ssh -L 8080:<guac-vm-ip>:8080 root@<proxmox-ip>
```

Then open http://localhost:8080/ .
Login with guacadmin:guacadmin
