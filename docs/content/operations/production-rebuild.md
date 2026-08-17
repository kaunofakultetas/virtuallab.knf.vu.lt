---
slug: /operations/production-rebuild
title: Production rebuild
description: Rebuilding the production Proxmox host from bare metal through to a verified isolation matrix.
---

# Production rebuild

Rebuilding the production host from a fresh Proxmox install through to isolated
lab networking with a measured isolation matrix.

Every step pairs a command with the thing that tells you it worked. Destructive
steps say so and carry a rollback.

:::warning Not yet exercised on production hardware
The properties in [Run the isolation matrix](#run-the-isolation-matrix) were
measured on the development host at `172.16.0.34`. Nothing below has been run on
production. Treat it as a plan, and expect to correct it as you go.
:::

| | |
| --- | --- |
| Host | `172.16.0.122` |
| Node name | `pve` |
| Target | Proxmox VE 9.x |
| Window | Summer, no active users |

Backup and inventory scripts live in `infra/prod-migration/`; host network
reconciliation in `scripts/`; the appliance definitions in
`infra/opentofu/lab/`.

## Why the rebuild

On the current production host, Guacamole and the application stack are **QEMU
VMs**. On development they are **LXC containers**, and every Access executor
assumes a container: it drives the guest with `pct exec`, sets its NIC with
`pct set`, and programs bridge VLAN membership on `veth200i1`. None of that
exists for a QEMU guest.

The alternative was a second, QEMU-only code path that could never be exercised
on development — so its first run would be on production. Rebuilding the two
appliances as containers means production runs the code that was actually
tested.

## Before you wipe

### The backup is verified, not just finished

Do not continue until `backup-before-reinstall.sh` ends with
`every guest dumped and verified`. Then restore one guest and boot it, because
that is the only evidence the archives are restorable.

```bash
zstd -dc /mnt/backup/proxmox-virtuallab/guests/9000.vma.zst | qmrestore - 8999
qm start 8999 && qm status 8999
qm destroy 8999
```

**Verify:** `qm status 8999` reports `running`. If it does not, stop — you have
no backup.

Copy `host-reference/interfaces` off the drive and onto something you can read
while the host is down. You retype the network configuration by hand, on a
machine you reach over that same network.

Worth adding to the drive if there is room, since it turns a later step from
"reconfigure from memory" into "restore":

```bash
# inside the old 201
docker compose exec -T postgres pg_dumpall -U postgres | gzip > /mnt/backup/app-db.sql.gz
tar -C /srv -czf /mnt/backup/stack.tar.gz virtual-proxmox-lab   # includes .env

# inside the old 200
tar -C <guacamole-compose-dir> -czf /mnt/backup/guac-data.tar.gz data
```

## Host

### If the host is a Hyper-V guest, fix the vSwitch first

Both lab hosts run Proxmox inside Hyper-V. The virtual switch filters frames
whose source MAC it did not assign, so every nested guest — the Gateway's uplink
NIC above all — is silently dropped the moment it puts its own MAC on the wire.

This presents as "the VM has no network" with nothing in Proxmox to explain it:
ARP leaves the Proxmox host correctly, and the upstream gateway simply never
replies to the guest while replying to the host. It cost a day on development.

Run this on the **Hyper-V host**, in an elevated PowerShell:

```powershell
# Find the Proxmox VM and its adapters
Get-VM
Get-VMNetworkAdapter -VMName * |
  Format-Table VMName, Name, SwitchName, MacAddressSpoofing, DhcpGuard, RouterGuard
```

```powershell
# Allow nested guests to use their own MACs
Set-VMNetworkAdapter -VMName "<proxmox-vm>" -MacAddressSpoofing On
```

Check `DhcpGuard` and `RouterGuard` are **Off** on the same adapter while you are
there. Both sound like sensible hardening and both break this design outright:
the Gateway *is* a DHCP server and *is* a router for the lab VLANs, so either
guard silently discards exactly the traffic the lab depends on.

```powershell
Set-VMNetworkAdapter -VMName "<proxmox-vm>" -DhcpGuard Off -RouterGuard Off
```

**Verify:**

```powershell
Get-VMNetworkAdapter -VMName "<proxmox-vm>" |
  Format-List Name, SwitchName, MacAddressSpoofing, DhcpGuard, RouterGuard
```

`MacAddressSpoofing : On`, both guards `Off`. It applies to a running VM without
a restart.

The lab VLANs themselves need nothing from Hyper-V: `vmbr20` has
`bridge-ports none`, so tagged lab traffic never leaves the Proxmox guest. Only
`vmbr0` reaches the vSwitch, and it carries untagged frames.

### Disconnect the backup drive

:::danger This is the step that loses everything
The installer offers every disk it can see, and the backup drive is one of
them. Physically detach it, or detach it in the hypervisor, before booting the
installer. Reconnect it only once the install is finished.

If you cannot detach it, write down its size and serial and check the installer's
target selection against them character by character.
:::

### Install Proxmox

Boot the PVE 9.x ISO. If this host is itself virtualised, attach the ISO as
virtual media and boot from it; otherwise write it to a USB stick with
`dd if=proxmox-ve_9.x.iso of=/dev/sdX bs=1M status=progress` (Rufus in DD mode
on Windows — ISO mode produces a stick that will not boot).

Answers the installer needs, all of which must match what the rest of this
document assumes:

| Prompt | Value | Why it matters |
| --- | --- | --- |
| Target disk | the original system disk | **Not** the backup drive |
| Filesystem | `ext4` (LVM) | Gives `local` + `local-lvm`; ZFS gives `local-zfs` and breaks every storage reference |
| `hdsize` | leave at maximum | |
| Hostname (FQDN) | `pve.<your domain>` | The short name is the node name |
| IP address | `172.16.0.122/22` | Netmask `255.255.252.0` |
| Gateway | `172.16.0.1` | |
| DNS | as before | |

The node name `pve` appears in every API path the orchestrator builds, so
a different name means editing `PROXMOX_NODE_NAME` and every forced command.

Choose **ext4, not ZFS**. The storage IDs `local` and `local-lvm` are referenced
throughout this document, in `pvesm` output the code reads, and in the restore
commands below. A ZFS install produces `local-zfs` instead and none of it lines
up.

Under *Advanced options* on the disk screen you can set `maxroot`, `minfree` and
`maxvz`. The defaults are fine; the previous host ran ten guests in 423 GB of
`local-lvm` at 60% used, and a class of thirty 32 GB clones needs considerably
more, so give the thin pool whatever the disk allows.

**Verify:** the web UI answers on `https://172.16.0.122:8006`, `pveversion`
reports 9.x, and `hostname` prints `pve`.

### Reconnect the backup drive and mount it

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT
mkdir -p /mnt/backup
mount /dev/disk/by-label/pve-backup /mnt/backup
ls /mnt/backup/proxmox-virtuallab/guests/
```

**Verify:** the archives are listed and `sha256sum -c` against `MANIFEST.txt`
still matches. The install did not touch this drive, but confirming costs
seconds and the alternative is discovering a problem after the guests are gone.

### Switch off the enterprise repository

A fresh install points at the subscription repository and fails every update
until this is changed. In the web UI: *Datacenter → the node → Updates →
Repositories*. Disable the `pve-enterprise` and `ceph` enterprise entries, then
**Add** the `pve-no-subscription` repository.

```bash
apt update && apt full-upgrade -y
reboot
```

**Verify:** `apt update` completes with no 401, and `pveversion` shows the
current point release after the reboot.

### Recreate the bridges, with VLAN filtering already on

Three bridges, matching the pre-rebuild inventory. The one difference is that
`vmbr20` is VLAN-aware from the start, so no live change is needed later while
guests are attached to it.

```ini
# /etc/network/interfaces
auto vmbr0
iface vmbr0 inet static
    address 172.16.0.122/22
    gateway 172.16.0.1
    bridge-ports nic0
    bridge-stp off
    bridge-fd 0

auto vmbr1
iface vmbr1 inet static
    address 10.10.10.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0

auto vmbr20
iface vmbr20 inet static
    address 10.10.20.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    bridge-vlan-aware yes
    bridge-vids 2000-2255
```

**Verify:**

```bash
cat /sys/class/net/vmbr20/bridge/vlan_filtering   # must print 1
ip -brief -4 addr show | grep vmbr
```

### Reconcile the host's DHCP, NAT and forwarding

The host answers DHCP and DNS on `10.10.10.1` and `10.10.20.1`, and NATs
`10.10.10.0/24` out `vmbr0`. That NAT is not optional: the Gateway's first boot
happens in bootstrap mode with its uplink *disconnected*, and the only way it
reaches the internet to install packages is through the host.

Run this from the repository on your workstation, not on the host:

```bash
./scripts/setup-proxmox-host-network.sh --host 172.16.0.122 --interactive-auth --dry-run
```

Read the plan, then apply it. The confirmation phrase names the host, so a
phrase copied from a development run will not apply here:

```bash
./scripts/setup-proxmox-host-network.sh \
    --host 172.16.0.122 \
    --interactive-auth \
    --apply \
    --confirmation 'APPLY NETWORK 172.16.0.122 vmbr1 vmbr20'
```

Add `--forward-app-ports` to both commands if the host should forward TCP
`80`/`443`/`8888` and UDP `443` to the application container. Whichever you
choose, use it consistently — omitting the flag on a later run *removes* those
rules.

**Verify:**

```bash
ssh root@172.16.0.122 'systemctl is-active dnsmasq; nft list table ip virtual_lab_host_network | head'
sysctl net.ipv4.ip_forward   # 1
```

The script creates no bridges. Proxmox owns those in `/etc/network/interfaces`,
because PVE does not read its configuration from sourced files and a bridge
under `interfaces.d` is invisible to both its API and backend readiness.

### Restore the templates and build VMs

```bash
mountpoint -q /mnt/backup || mount /dev/disk/by-label/pve-backup /mnt/backup
for id in 100 101 102 103 104 9000 9002 9004; do
    zstd -dc /mnt/backup/proxmox-virtuallab/guests/$id.vma.zst | qmrestore - $id
done
```

**Verify:** `qm list` shows all eight, and `qm config 9000 | grep template`
confirms the templates are still templates.

## Appliances

All three appliances — Guacamole (`200`), the application stack (`201`) and the
Gateway (`202`) — are declared in the OpenTofu module at `infra/opentofu/lab`,
along with the `labzone` SDN zone. Build them from that module rather than by
hand. It is what development was built from, so it is the only description of
these guests that has actually been exercised.

| ID | Guest | Kind | Addresses |
| --- | --- | --- | --- |
| `200` | `guacamole` | unprivileged LXC | `10.10.10.50/24`, `10.10.20.10/24` |
| `201` | `api-docker` | unprivileged LXC | `10.10.10.100/24` |
| `202` | `lab-gateway` | QEMU VM | `10.10.10.2/24`, VLAN trunk `2000-2255`, uplink |

Both containers are **unprivileged**, with `nesting=1`. That is enough: the
Access applier's `nft -f` runs inside the container's own network namespace,
where an unprivileged container still holds `CAP_NET_ADMIN`. Do not build them
privileged to "make nftables work" — it is not needed, and it hands a container
breakout the host.

`10.10.10.100` is not arbitrary. It is the only source the Access ruleset admits
to Guacamole's ports, and the only source the node firewall rules below admit to
the Proxmox API. Changing it means changing both.

### Create an API token for OpenTofu

A fresh install has none. The module needs `Sys.Audit` and `Sys.Modify` on `/`,
`Datastore.AllocateTemplate`, and SDN allocation, so the simplest correct answer
on a single-admin host is a `root@pam` token with privilege separation off:

```bash
pveum user token add root@pam opentofu --privsep 0
```

The secret is printed **once**. This is not the token the backend uses for
network reconciliation — those are separate, scoped to `/sdn`, and created
further down.

### Keep production state separate from development

:::danger The state file is the risk, not the plan
`.state/terraform.tfstate` currently describes node `virtuallabdev`. Point the
existing configuration at production and apply, and OpenTofu reconciles
production against development's recorded state — and overwrites the only
record of what development owns.
:::

Use a workspace, which gives production its own state file under
`terraform.tfstate.d/` and leaves the development state untouched:

```bash
cd infra/opentofu/lab
tofu workspace new prod        # tofu workspace select prod, on later runs
tofu workspace list            # confirm the * is on prod
```

Then a separate variables file. Note that `terraform.tfvars` is still loaded
automatically, so `prod.tfvars` must override every value that differs — at
minimum the endpoint, the token and the node name:

```hcl
# infra/opentofu/lab/prod.tfvars
proxmox_endpoint  = "https://172.16.0.122:8006/"
proxmox_api_token = "root@pam!opentofu=<secret>"
proxmox_insecure  = true
node_name         = "pve"

guest_ssh_public_key = "ssh-ed25519 AAAA... virtual-proxmox-lab-prod"

# The Proxmox host's own key. Not optional: the Gateway forced commands run as
# root on the host and reach the guest over SSH as gateway-admin, so without
# this every gateway apply fails with permission denied.
additional_guest_ssh_public_keys = [
  "ssh-ed25519 AAAA... root@pve",   # cat /root/.ssh/id_ed25519.pub on the host
]

# Must differ from development. Both Gateways share one campus broadcast
# domain, and the default is development's address.
gateway_uplink_address = "172.16.0.123/22"
gateway_uplink_gateway = "172.16.0.1"

# First boot happens with the uplink disconnected, so the guest is never on
# the campus segment before its nftables policy exists.
gateway_bootstrap_mode = true
gateway_started        = true
```

Pick the uplink address from something demonstrably free — `arping -D` it from
the host before committing to it — and record it, because the Gateway policy
renderer and the node firewall both refer to it.

`prod.tfvars` holds an API token in plain text. It is git-ignored; keep its
permissions restricted and never commit it.

### Apply

```bash
tofu init
tofu validate
tofu plan -var-file=prod.tfvars -out=.state/prod.tfplan
```

**Verify before applying:** the plan is `7 to add, 0 to change, 0 to destroy` —
two image downloads, the SDN zone and its applier, the two containers and the
Gateway VM. Anything marked *destroy*, or a plan that reports no changes at
all, means the wrong workspace is selected. Stop and check
`tofu workspace list`.

```bash
tofu apply .state/prod.tfplan
tofu output
```

**Verify:**

```bash
ssh root@172.16.0.122 'pct list; qm list; ip link show veth200i1'
```

Containers `200` and `201` running, VM `202` present, and the host-side veth
exists — that veth name is what the trunk reconciler programs.

### Record the Gateway's interface names

Log into the Gateway and read them off the guest. They are inputs, not defaults
— `ens19` and `eth2` on development, but predictable-names hardware can produce
something else, and the renderer writes whatever you record.

`10.10.10.0/24` lives on `vmbr1`, which has `bridge-ports none`. It is reachable
from the Proxmox host and the two containers and from nowhere else, so run this
on the host — from a workstation it returns nothing at all, which reads exactly
like a Gateway that failed to boot.

```bash
ssh root@172.16.0.122 \
  "ssh -o StrictHostKeyChecking=accept-new gateway-admin@10.10.10.2 \
   'ip -brief addr; ip route show default'"
```

Management address present and the default route still through `10.10.10.1`
while bootstrap mode is on. The trunk (`ens19`) and uplink (`eth2`) are both
`DOWN` at this point and that is correct: the uplink carries `link_down=1` from
bootstrap mode, and the trunk parent is brought up by its own networkd unit
during the first policy apply.

If it does return nothing, VM `202` has no serial console and no guest agent, so
`qm terminal` and `qm guest exec` are both unavailable. Diagnose with
`qm status 202`, then `ip neigh show 10.10.10.2 dev vmbr1` — an entry there means
the guest is on the bridge and the problem is the key, not the boot.

The trunk NIC carries the whole approved pool `2000-2255` rather than only
allocated tags, because Proxmox applies a trunk list to a NIC and a running
guest does not pick up changes without a NIC reconfigure.

### Install the Gateway's own packages

Neither the OpenTofu module nor the cloud image provides these, and the policy
apply needs all three: it validates staged configuration with `squid -k parse`
and `dnsmasq --test`, then requires `nftables`, `dnsmasq` and `squid` to all
report `is-active` before it will commit. This is what bootstrap mode's host NAT
exists for — the guest reaches the internet through `10.10.10.1`.

```bash
ssh root@172.16.0.122 "ssh gateway-admin@10.10.10.2 \
  'sudo apt-get update && sudo apt-get install -y dnsmasq squid && \
   sudo systemctl enable --now nftables'"
```

Install `squid-openssl`, **not** `squid`. Ubuntu's stock package is built
without OpenSSL, and the rendered configuration uses `ssl-bump`, so validation
fails with `FATAL: Unknown https_port option 'ssl-bump'` — a message that names
the config rather than the package, and sends you looking in the wrong place.

The rendered configuration also references a certificate that nothing in this
repository creates ([`gateway-render.ts`](https://github.com/kaunofakultetas/virtuallab.knf.vu.lt/blob/main/backend/src/network/gateway-render.ts) writes
`cert=/etc/squid/ssl/gateway-bump.pem`). Generate it before the first apply:

```bash
sudo install -d -m 0755 /etc/squid/ssl
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /tmp/bump.key -out /tmp/bump.crt \
  -subj "/CN=virtual-lab-gateway-bump" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign,digitalSignature"
sudo sh -c 'cat /tmp/bump.crt /tmp/bump.key > /etc/squid/ssl/gateway-bump.pem'
sudo rm -f /tmp/bump.key /tmp/bump.crt
sudo chown proxy:proxy /etc/squid/ssl/gateway-bump.pem
sudo chmod 0400 /etc/squid/ssl/gateway-bump.pem
```

The applier writes its ruleset to `/etc/nftables.d/virtual-lab-gateway.nft` and
then runs `nft -f /etc/nftables.conf`. Ubuntu's stock file does not include that
directory, so without this the managed table is written and never loaded:

```bash
sudo install -d -m 0755 /etc/nftables.d
echo 'include "/etc/nftables.d/*.nft"' | sudo tee -a /etc/nftables.conf
sudo nft -f /etc/nftables.conf
```

`nftables.service` must be enabled explicitly. The applier runs
`nft -f /etc/nftables.conf` directly and never starts the unit, so without this
its own `verify` step reports `services_inactive: ["nftables"]` and the apply
never converges. Ubuntu's stock `/etc/nftables.conf` sets no `policy drop`, so
enabling it now cannot lock you out.

**Verify:** `nftables` and `squid` both `active`, `systemd-networkd` `active`.
`dnsmasq` will be `failed` until the first policy apply — stock configuration
binds `0.0.0.0:53` and collides with `systemd-resolved`; the rendered
configuration uses `bind-dynamic` with the uplink and management interfaces
excluded, and starts cleanly.

## Control plane

### Confirm the SDN zone

OpenTofu created `labzone` in the previous step; this only checks it landed.

```bash
pvesh get /cluster/sdn/zones
pvesh get /cluster/sdn/vnets
```

**Verify:** `labzone` is listed on `vmbr20`, and the VNet list is empty. Any
`vlp*` VNet is token-preflight residue and should be removed.

If the zone is missing, apply it on its own rather than by hand, so state stays
truthful:

```bash
tofu apply -var-file=prod.tfvars -target=proxmox_sdn_zone_vlan.lab
```

### Install the forced commands

Run this from the repository on your workstation. It is a dry run by default,
and it reports drift rather than assuming the host is empty:

```bash
./scripts/install-forced-commands.sh --host 172.16.0.122 --dry-run
./scripts/install-forced-commands.sh --host 172.16.0.122 --apply
```

**Verify:** the script does it — it compares `sha256sum` for all nine files
after installing and exits non-zero if any differs. These run as root behind
SSH, so a stale copy is a contract boundary drifting silently.

Run it again after **any** change to `infra/access/*.py` or `infra/gateway/*.py`.
The host holds a copy, not a checkout, so a pushed change is inert until it is
installed here — and because the renderer in the application container and the
applier on the host are two halves of one contract, they must be updated
together. Redeploy `201` first, then install, then force one apply.

### Generate five SSH principals

Each is a separate key with its own forced command, so a capability can be
revoked on its own and an apply can prove convergence over a different
connection than the one that made the change.

| Principal | Forced command | Can |
| --- | --- | --- |
| `access-observer` | `observe_access_forced_command.py` | read only |
| `access-applier` | `apply_access_forced_command.py` | write guest policy |
| `access-trunk-applier` | `apply_access_trunk_forced_command.py` | change the trunk |
| `gateway-observer` | `observe_gateway_forced_command.py` | read only |
| `gateway-applier` | `apply_gateway_forced_command.py` | write guest policy |

```bash
d=/srv/virtual-proxmox-lab-secrets/<name>
ssh-keygen -q -t ed25519 -N "" -C "virtual-lab-<name>" -f $d/id_ed25519
```

Then in the host's `/root/.ssh/authorized_keys`:

```text
restrict,command="PROXMOX_NODE_NAME=pve /usr/local/libexec/virtual-lab/<cmd>.py" ssh-ed25519 AAAA... virtual-lab-<name>
```

The `PROXMOX_NODE_NAME` prefix is not optional. Both observer forced commands
read it from their own environment and have no default, so without it every
observation fails with `PROXMOX_NODE_NAME is missing or malformed` — and because
each applier proves convergence over the observer channel, every apply fails with
it. `command=` is run through a shell, so the assignment works there and
`PermitUserEnvironment` does not need to be enabled. Carrying it on all five
entries is harmless; the three that ignore it are unaffected.

**Verify** separation rather than assuming it. Each key must refuse the others'
work:

```text
trunk key   + target "access"        -> unsupported request
access key  + target "access-trunk"  -> unsupported request
any key     + a shell command        -> forced command runs instead
```

## Firewall

### Add the node rules first

:::danger Ordering is not optional
Enabling the datacenter firewall without these rules cut the orchestrator off
entirely on the development host. The API and every restricted SSH channel are
reached from `10.10.10.100`, which sits outside the management network Proxmox
auto-admits — so guests stayed perfectly reachable while the control plane went
dark.
:::

```bash
pvesh create /nodes/pve/firewall/rules --type in --action ACCEPT \
  --source 10.10.10.100 --proto tcp --dport 8006 --enable 1 \
  --comment "virtual-lab: orchestrator control plane (Proxmox API)"
pvesh create /nodes/pve/firewall/rules --type in --action ACCEPT \
  --source 10.10.10.100 --proto tcp --dport 22 --enable 1 \
  --comment "virtual-lab: orchestrator control plane (restricted SSH)"
```

Add your own administration source too, unless you reach the host from within
`172.16.0.0/22`. Proxmox auto-admits only the node's own management network, so
an administrator arriving from anywhere else — a campus NAT address, a VPN pool —
is cut off the moment the datacenter firewall comes on, with no way back except
the console or the rollback timer.

```bash
# the address the host actually sees you from: ssh root@172.16.0.122 'echo $SSH_CLIENT'
pvesh create /nodes/pve/firewall/rules --type in --action ACCEPT \
  --source <your address> --proto tcp --dport 22 --enable 1 \
  --comment "virtual-lab: administrator SSH"
pvesh create /nodes/pve/firewall/rules --type in --action ACCEPT \
  --source <your address> --proto tcp --dport 8006 --enable 1 \
  --comment "virtual-lab: administrator web UI"
```

**Verify:** `pvesh get /nodes/pve/firewall/rules` lists all four, before you
touch the next step.

### Enable the datacenter firewall behind a dead-man's switch

This is the master switch for every per-VM rule. With it off, guest policy is
inert and student VMs on one VLAN can reach each other freely. It is also the one
step that is cluster-wide.

Restored guests have no `.fw` files, so they should be unaffected — but arm the
rollback before the enable, not after.

```bash
cat > /tmp/fw-rollback.sh <<'EOF'
#!/bin/sh
pvesh set /cluster/firewall/options --enable 0
EOF
chmod 700 /tmp/fw-rollback.sh
systemd-run --on-active=900 --unit=virtual-lab-firewall-rollback /bin/sh /tmp/fw-rollback.sh

pvesh set /cluster/firewall/options --enable 1
```

**Verify within the window:** the Proxmox API answers from inside 201, Guacamole
answers, and every restored guest still pings. Only then commit:

```bash
systemctl stop virtual-lab-firewall-rollback.timer
systemctl reset-failed virtual-lab-firewall-rollback.timer virtual-lab-firewall-rollback.service
```

**Rollback:** do nothing and the timer disables the firewall in 15 minutes. To
act sooner, `pvesh set /cluster/firewall/options --enable 0`.

## Application

### Install Guacamole into 200

The lifecycle script installs Docker, clones the repository, and starts the
role's Compose project. Run it as root on the Proxmox host.

```bash
curl -fsSL \
  https://raw.githubusercontent.com/kaunofakultetas/virtuallab.knf.vu.lt/main/scripts/manage-lxc-workload.sh \
  -o /tmp/manage-lxc-workload.sh
pct push 200 /tmp/manage-lxc-workload.sh /tmp/manage-lxc-workload.sh --perms 0755
pct exec 200 -- /tmp/manage-lxc-workload.sh install \
  --role guacamole \
  --repository https://github.com/kaunofakultetas/virtuallab.knf.vu.lt.git
```

**Verify:**

```bash
pct exec 200 -- ss -Hlnt | grep -E ':(8080|9443)'
```

Both ports listening. The script refuses to run unless the container's hostname
matches the role, which is the guard against installing Guacamole into 201.

### Install the checkout into 201

Same script, different role. This one stops after the checkout, because `.env`
does not exist yet:

```bash
pct push 201 /tmp/manage-lxc-workload.sh /tmp/manage-lxc-workload.sh --perms 0755
pct exec 201 -- /tmp/manage-lxc-workload.sh install \
  --role api-docker \
  --repository https://github.com/kaunofakultetas/virtuallab.knf.vu.lt.git
```

### Provision the Proxmox tokens

Three tokens, deliberately not one. Network reconciliation uses two dedicated,
privilege-separated tokens scoped to `/sdn`; the broad provisioning token is
never substituted for them, because the whole point is that a reconciliation bug
cannot touch a VM or a datastore.

```bash
# Provisioning: clones, power state, guest firewall
pveum user token add root@pam virtual-lab --privsep 0

# Network reconciliation, scoped to /sdn only
pveum user add virtual-lab-network@pve
pveum acl modify /sdn --user virtual-lab-network@pve --role PVESDNAdmin
pveum user token add virtual-lab-network@pve observer --privsep 1
pveum user token add virtual-lab-network@pve mutator  --privsep 1

# A token created with --privsep 1 carries NO permissions of its own, and its
# effective rights are the intersection of the user's and the token's. Granting
# the role to the user alone leaves both tokens unable to do anything.
pveum role add VirtualLabSDNAudit --privs "SDN.Audit"
pveum acl modify /sdn --tokens "virtual-lab-network@pve!observer" --role VirtualLabSDNAudit
pveum acl modify /sdn --tokens "virtual-lab-network@pve!mutator"  --role PVESDNAdmin
```

The roles are not interchangeable. `PVESDNUser` is only `SDN.Audit,SDN.Use` — it
cannot create a VNet, so a mutator holding it fails the preflight with
`mutator_create=403`. Allocation lives in `PVESDNAdmin`. The observer gets the
custom audit-only role instead, which is what makes its writes return `403`
while its reads succeed.

Each secret prints once.

**Verify:** `pveum acl list` shows three rows — the user with `PVESDNAdmin`, and
one row per token, `type` `token`.

### Write `.env`

```bash
pct exec 201 -- cp /srv/virtual-proxmox-lab/backend/.env.example \
  /srv/virtual-proxmox-lab/.env
pct exec 201 -- chmod 600 /srv/virtual-proxmox-lab/.env
pct enter 201
vi /srv/virtual-proxmox-lab/.env
```

Values that must change from the example on this host:

| Variable | Value |
| --- | --- |
| `POSTGRES_PASSWORD` | freshly generated |
| `BACKEND_JWT_SECRET` | freshly generated; rotating it invalidates every session |
| `PROXMOX_HOST_ADDRESS` | `172.16.0.122` |
| `PROXMOX_BASE_URL` | `https://exit:8006` |
| `PROXMOX_NODE_NAME` | `pve` |
| `PROXMOX_AUTH_TOKEN` | the `root@pam!virtual-lab` secret |
| `PROXMOX_NETWORK_OBSERVER_AUTH_TOKEN` | the `observer` secret |
| `PROXMOX_NETWORK_MUTATOR_AUTH_TOKEN` | the `mutator` secret |
| `GUACAMOLE_USER`, `GUACAMOLE_PASS` | as configured in 200 |
| `GUACAMOLE_PUBLIC_URL` | the public URL students reach |

`PROXMOX_NODE_NAME` is the short node name, and it appears in every API path the
orchestrator builds. If the installer was given a different hostname than
`pve`, this is where that decision surfaces.

The backend uses `exit:8006` and `exit:8080` rather than addresses, because it
runs on an internal Docker network and reaches both through the `exit` proxy.
`PROXMOX_HOST_ADDRESS` is where that proxy is told to forward: it is the one
Proxmox setting that must be a raw address, because the proxy forwards TCP
before any name resolution happens. Set it wrong and every API call returns
`401` rather than failing to connect — the symptom looks like a bad token, not a
misrouted connection.

The five SSH principals created earlier are also configured here — a
`*_HOST`, `*_USER`, `*_PORT`, `*_COMMAND` and `*_CREDENTIALS_DIR` group per
principal, for `ACCESS_OBSERVER`, `ACCESS_APPLIER`, `ACCESS_TRUNK_APPLIER`,
`GATEWAY_OBSERVER` and `GATEWAY_APPLIER`:

```ini
ACCESS_OBSERVER_HOST=exit
ACCESS_OBSERVER_PORT=2222
ACCESS_OBSERVER_HOST_KEY_ALIAS=10.10.10.1
ACCESS_OBSERVER_USER=root
ACCESS_OBSERVER_COMMAND=virtual-lab-access-observe
ACCESS_OBSERVER_CREDENTIALS_DIR=/srv/virtual-proxmox-lab-secrets/access-observer
```

The host is `exit`, **not** `10.10.10.1`, and the port is `2222`. The backend runs
on a Compose network declared `internal: true`, so it has no route off the Docker
bridge at all; every outbound connection goes through the `exit` proxy, which
forwards `:2222` to the Proxmox host's `:22`. Configured with the address from
`.env.example` the applies fail with
`Restricted SSH exited with code 255: ssh: connect to host 10.10.10.1 port 22: Network unreachable`.

`*_HOST_KEY_ALIAS` then keeps `StrictHostKeyChecking=yes` working: the key is
verified under the alias rather than under `exit`, so the `known_hosts` files
generated by `ssh-keyscan 10.10.10.1` still match.

`*_CREDENTIALS_DIR` appears in no example file but Compose requires it, and
`ACCESS_OBSERVER_CREDENTIALS_DIR` is marked mandatory — omit it and
`docker compose` refuses to start at all. The other four fall back to a committed
empty directory, so omitting *those* is silent: the stack comes up healthy and
every apply refuses later.

Do **not** set `*_IDENTITY_FILE` or `*_KNOWN_HOSTS_FILE` here. `docker-compose.yml`
sets them explicitly to `/run/<principal>/id_ed25519` and `/run/<principal>/known_hosts`,
and a service-level `environment:` entry overrides `env_file`, so a value here is
ignored. The example file's `/run/secrets/...` paths are stale.

The directories are on **container 201**, not the Proxmox host — 201 is the
Docker host that Compose bind-mounts from. Each must contain `id_ed25519` and a
`known_hosts` carrying the Proxmox host's key
(`ssh-keyscan -t ed25519 10.10.10.1`), owned by UID `1001` and mounted read-only.
Reconciliation returns `503` rather than starting SSH when any of it is
incomplete.

### Deploy

First create the Docker network the Compose file declares as external, because
nothing on this path has created it yet. `manage-lxc-workload.sh` does it in
`prepare_runtime`, but for the `api-docker` role `install` returns early when
`.env` is absent — which is exactly the order this document uses — and
`runUpdateThisStack.sh` never calls it. Without this the deploy fails at the
first Compose command with `network external declared as external, but could not
be found`, rolls the images back, and leaves the database untouched.

```bash
pct exec 201 -- sh -lc 'cd /srv/virtual-proxmox-lab && \
  docker network inspect external >/dev/null 2>&1 || docker network create external'
pct exec 201 -- sh -lc 'cd /srv/virtual-proxmox-lab && \
  install -d -m 0750 _DATA/postgres _DATA/caddy_logs'
```

```bash
pct exec 201 -- sh -lc 'cd /srv/virtual-proxmox-lab && ./runUpdateThisStack.sh'
```

The deploy backs up PostgreSQL, builds tagged images, applies `schema.sql` in one
transaction, waits for health, and finishes with an authenticated read-only
reconciliation smoke test. A failure after the images are swapped restores the
previous ones automatically; database changes are not reversed, and the backup
path is printed.

:::note The first deploy on a virgin database fails at the last step
The smoke test needs an admin account, and `schema.sql` seeds only the
`system-drift-reconciler` student. Expect
`an admin user is required for the reconciliation smoke test`. The stack is up
by that point — create the admin, then rerun the deploy and it passes.
:::

```bash
pct exec 201 -- sh -lc 'cd /srv/virtual-proxmox-lab && \
  ADMIN_PASSWORD="<password>" docker compose exec -T backend \
  npm run create-admin -- --vu-id <numeric-id>'
```

**Verify:**

```bash
pct exec 201 -- sh -lc 'cd /srv/virtual-proxmox-lab && docker compose ps'
pct exec 201 -- sh -lc 'cd /srv/virtual-proxmox-lab && \
  docker compose exec -T backend npm run preflight-network-tokens'
```

`preflight-network-tokens` exits `0`. Note that `final_read=500` in its output
is expected — that is Proxmox's status for reading the disposable VNet after it
has been deleted, and the script accepts it.

Every service healthy. Observer reads succeed and observer writes return 403;
the mutator can create, apply, read and delete a disposable VNet; both enumerate
zero VMs and zero storages. That last part is the one that matters — it proves
the scoped tokens cannot see the templates you just restored.

### Record the Gateway's runtime facts

Interface names cannot be derived from the database, and rendering policy against
guessed names produces plausible, wrong configuration. Use the names recorded
when the Gateway was built.

The script parses no flags at all — it reads four environment variables, so it
must be invoked with `-e` and not with the arguments its name suggests.

```bash
docker compose exec -T \
  -e GATEWAY_MANAGEMENT_INTERFACE=eth0 \
  -e GATEWAY_TRUNK_INTERFACE=ens19 \
  -e GATEWAY_UPLINK_INTERFACE=eth2 \
  -e GATEWAY_UPSTREAM_RESOLVERS=1.1.1.1,8.8.8.8 \
  backend npm run set-gateway-settings
```

**Verify:** `GET /network/readiness` shows `gateway-runtime-settings` passing
with the interface names you expect.

### Leave bootstrap mode — before the Gateway apply, not after

:::danger The variable's own documentation has this backwards
`variables.tf` says to clear `gateway_bootstrap_mode` "once the guest policy is
applied and verified". It cannot be done in that order. `gateway-uplink-connected`
and `gateway-default-route` are deliberately **not** in
`GATEWAY_APPLY_FIXABLE_CHECKS` — they describe hypervisor state no amount of file
writing corrects — so the apply refuses while the uplink is down.
:::

```bash
# set gateway_bootstrap_mode = false in prod.tfvars, then
cd infra/opentofu/lab
tofu plan  -var-file=prod.tfvars -target=proxmox_virtual_environment_vm.gateway -out=.state/bootstrap-off.tfplan
tofu apply .state/bootstrap-off.tfplan
```

**Verify:** `0 to add, 1 to change, 0 to destroy` in the plan, then on the guest
`eth2` holds the uplink address and `ip route show default` shows exactly one
route, through `eth2`.

The provider reboots the VM to apply the change, and because the cloud-init
configuration changed, the guest gets a **new instance id** — so cloud-init re-runs
its per-instance modules and **regenerates the SSH host keys**. The host's
`known_hosts` is then stale, and since the Gateway forced commands use
`StrictHostKeyChecking=yes`, every gateway apply fails until you refresh it:

```bash
ssh-keygen -f /root/.ssh/known_hosts -R 10.10.10.2
ssh-keyscan -t ed25519 10.10.10.2 >> /root/.ssh/known_hosts
```

Between this step and the apply below, the Gateway sits on the campus segment
with only stock accept-policy nftables. Keep the window short.

### Flip to active before the Access applies

Both Access runners refuse unless `settings.network.mode` is exactly `active`,
and the shipped default is `legacy`. The doc's "Go live" section flips it *after*
these applies, which cannot work. The API route for the flip is itself gated on
`ready_for_active`, so SQL is the only path at this point.

```bash
pct exec 201 -- sh -lc 'cd /srv/virtual-proxmox-lab && docker compose exec -T postgres \
  psql -U postgres -d backend_db -c \
  "UPDATE metadata SET value = to_jsonb('"'"'active'"'"'::text) WHERE key = '"'"'settings.network.mode'"'"';"'
```

`apply-gateway-policy` has no such gate and can run before this.

### Apply Gateway and Access policy

Each stages, arms its own rollback timer, installs, reloads, and then proves
convergence over the read-only channel before committing.

```bash
npm run apply-gateway-policy -- --requested-by <vu_id> \
  --expected-revision <sha256> --confirm APPLY-GATEWAY-POLICY
npm run apply-access-trunk   -- --requested-by <vu_id> \
  --expected-revision <sha256> --confirm APPLY-ACCESS-TRUNK
npm run apply-access-policy  -- --requested-by <vu_id> \
  --expected-revision <sha256> --confirm APPLY-ACCESS-POLICY
```

**Verify:** each prints `"status":"succeeded"`, then `GET /network/readiness`
reports `ready_for_active: true` with zero failing checks.

**Rollback:** do not commit and the guest's own timer restores the previous state
within five minutes. A failed apply is already compensated by the time it
reports.

## Go live

### Flip to active and provision one throwaway VM

```sql
UPDATE metadata SET value = to_jsonb('active'::text)
 WHERE key = 'settings.network.mode';
```

Create one VM through the API as a real user and let it boot.

**Verify:** the group reaches `active`, an SDN VNet appears, both appliances gain
a VLAN subinterface, a `.fw` file is written for the VM, and it takes a DHCP
lease within about fifteen seconds.

### Run the isolation matrix

Same-group reachability is a per-profile decision, not a global property. A
profile with `allow_same_group` set admits the group's own subnet on every port
and protocol; a profile without it leaves one VM unable to open a single port on
another. It is set by default — in the schema, in the API validator, and on the
seeded `Default` profile — so measure the matrix on a profile of each kind and
record which one each row was measured against. Toggling the flag converges on
the next drift pass rather than immediately, so allow up to ten minutes before
re-measuring.

Provision a second VM under a **different owner**, and a third under the **same**
owner and profile, then measure all of it. A network group is keyed on owner and
profile, so one account cannot produce two groups on the same profile — the
second VM lands in a different group and the third lands in the same one, which
is the pair the `allow_same_group` rows exercise.

| Probe | Expected |
| --- | --- |
| VM A → VM B, different groups, unpeered, any port | blocked |
| VM A → VM B, same group, profile allows it, any TCP port | open |
| VM A → VM B, same group, profile allows it, UDP and ICMP | open |
| VM A → VM B, same group, profile forbids it, any port | blocked |
| VM A → VM B, same profile but different owners, unpeered | blocked |
| Access → VM on any other port, profile allows same-group | blocked |
| Gateway → VM on any TCP port, profile allows same-group | blocked |
| Gateway → VM, ICMP | works |
| After turning the profile flag off, within one drift pass | blocked again |
| VM → another group's gateway address | blocked |
| VM → its own gateway, DNS | works |
| VM → allowlisted domain, HTTP and HTTPS | 200 |
| VM → non-allowlisted domain | 403 / terminated |
| VM sourcing from outside its own /24 | blocked |
| VM sourcing from the Gateway or Access address | blocked |
| Access → VM on the template's session port | open |
| Access → VM on any other port | blocked |
| After peering, both directions | open |
| After removing the peering | blocked again |

Test TCP with `bash -c "</dev/tcp/host/port"`, **not** `sh`. `/dev/tcp` is a bash
feature; under dash the probe reports failure regardless of the firewall, which
cost an hour of misdiagnosis on the development host.

### Delete the throwaway VMs and confirm the VLANs return

**Verify:** group rows gone, SDN VNets removed, both appliances' VLAN interfaces
pruned, `.fw` files deleted, and the Access trunk back to carrying only VLAN
2000. Provision once more and confirm the VLAN is reused.

### Soak before students return

Nothing has run with more than two concurrent groups. A class of thirty means
thirty VLAN subinterfaces on each appliance, thirty dnsmasq scopes, thirty Squid
ACL blocks, and a drift pass reading every VM's firewall every ten minutes.

Provision to a realistic count, leave it overnight, and check that the drift
reconciler stays quiet and readiness still passes in the morning.
