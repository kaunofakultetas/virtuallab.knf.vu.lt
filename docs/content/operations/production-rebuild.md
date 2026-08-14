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
| Node name | `virtuallab` |
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
| Hostname (FQDN) | `virtuallab.<your domain>` | The short name is the node name |
| IP address | `172.16.0.122/22` | Netmask `255.255.252.0` |
| Gateway | `172.16.0.1` | |
| DNS | as before | |

The node name `virtuallab` appears in every API path the orchestrator builds, so
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
reports 9.x, and `hostname` prints `virtuallab`.

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
    bridge-vids 2-4094
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
mkdir -p /mnt/backup && mount /dev/sdb1 /mnt/backup
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
node_name         = "virtuallab"

guest_ssh_public_key = "ssh-ed25519 AAAA... virtual-proxmox-lab-prod"

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

```bash
ssh gateway-admin@10.10.10.2 'ip -brief addr; ip route show default'
```

Management address present, trunk parent up with no address of its own, and the
default route still through `10.10.10.1` while bootstrap mode is on.

The trunk NIC carries the whole approved pool `2000-2255` rather than only
allocated tags, because Proxmox applies a trunk list to a NIC and a running
guest does not pick up changes without a NIC reconfigure.

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

```bash
scp infra/gateway/*.py infra/access/*.py root@172.16.0.122:/usr/local/libexec/virtual-lab/
ssh root@172.16.0.122 'chmod 755 /usr/local/libexec/virtual-lab/*.py'
```

**Verify:** compare `sha256sum` against your working copy. These run as root
behind SSH, so a stale copy is a contract boundary drifting silently.

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
restrict,command="/usr/local/libexec/virtual-lab/<cmd>.py" ssh-ed25519 AAAA... virtual-lab-<name>
```

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
pvesh create /nodes/virtuallab/firewall/rules --type in --action ACCEPT \
  --source 10.10.10.100 --proto tcp --dport 8006 --enable 1 \
  --comment "virtual-lab: orchestrator control plane (Proxmox API)"
pvesh create /nodes/virtuallab/firewall/rules --type in --action ACCEPT \
  --source 10.10.10.100 --proto tcp --dport 22 --enable 1 \
  --comment "virtual-lab: orchestrator control plane (restricted SSH)"
```

**Verify:** `pvesh get /nodes/virtuallab/firewall/rules` lists both, before you
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
pveum aclmod /sdn --user virtual-lab-network@pve --role PVESDNUser
pveum user token add virtual-lab-network@pve observer --privsep 1
pveum user token add virtual-lab-network@pve mutator  --privsep 1
```

Each secret prints once.

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
| `PROXMOX_BASE_URL` | `https://exit:8006` |
| `PROXMOX_NODE_NAME` | `virtuallab` |
| `PROXMOX_AUTH_TOKEN` | the `root@pam!virtual-lab` secret |
| `PROXMOX_NETWORK_OBSERVER_AUTH_TOKEN` | the `observer` secret |
| `PROXMOX_NETWORK_MUTATOR_AUTH_TOKEN` | the `mutator` secret |
| `GUACAMOLE_USER`, `GUACAMOLE_PASS` | as configured in 200 |
| `GUACAMOLE_PUBLIC_URL` | the public URL students reach |

`PROXMOX_NODE_NAME` is the short node name, and it appears in every API path the
orchestrator builds. If the installer was given a different hostname than
`virtuallab`, this is where that decision surfaces.

The backend uses `exit:8006` and `exit:8080` rather than addresses, because it
runs on an internal Docker network and reaches both through the `exit` proxy.

The five SSH principals created earlier are also configured here — one
`*_HOST`, `*_USER`, `*_IDENTITY_FILE`, `*_KNOWN_HOSTS_FILE` and `*_COMMAND`
group per principal, for `ACCESS_OBSERVER`, `ACCESS_APPLIER`,
`ACCESS_TRUNK_APPLIER`, `GATEWAY_OBSERVER` and `GATEWAY_APPLIER`. Compose mounts
the credentials directory read-only, and the files must be readable by container
UID `1001`. Reconciliation returns `503` rather than starting SSH when any of it
is incomplete.

### Deploy

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

Every service healthy. Observer reads succeed and observer writes return 403;
the mutator can create, apply, read and delete a disposable VNet; both enumerate
zero VMs and zero storages. That last part is the one that matters — it proves
the scoped tokens cannot see the templates you just restored.

### Record the Gateway's runtime facts

Interface names cannot be derived from the database, and rendering policy against
guessed names produces plausible, wrong configuration. Use the names recorded
when the Gateway was built.

```bash
docker compose exec -T backend npm run set-gateway-settings -- \
  --management eth0 --trunk ens19 --uplink eth2 --resolvers 1.1.1.1,8.8.8.8
```

**Verify:** `GET /network/readiness` shows `gateway-runtime-settings` passing
with the interface names you expect.

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

Provision a second VM under a **different owner**, then measure all of it. A
network group is keyed on owner and profile, so one account cannot produce two
groups on the same profile.

| Probe | Expected |
| --- | --- |
| VM A → VM B, unpeered, any port | blocked |
| VM → another group's gateway address | blocked |
| VM → its own gateway, DNS | works |
| VM → allowlisted domain, HTTP and HTTPS | 200 |
| VM → non-allowlisted domain | 403 / terminated |
| VM → spoofed source address | blocked |
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
