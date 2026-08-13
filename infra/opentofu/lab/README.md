# OpenTofu lab infrastructure

This root manages the Ubuntu LXC template, two persistent unprivileged
containers, the persistent `labzone` VLAN SDN zone, and the stopped Gateway VM
base on Proxmox:

| VMID | Name | CPU | RAM | Root disk | Networks |
| --- | --- | --- | --- | --- | --- |
| 200 | `guacamole` | 4 | 10 GB | 32 GB | `10.10.10.50/24`, `10.10.20.10/24` |
| 201 | `api-docker` | 4 | 6 GB | 32 GB | `10.10.10.100/24` |
| 202 | `lab-gateway` | 2 | 4 GB | 16 GB | `10.10.10.2/24`, VLAN trunk `2000-2255`, uplink `172.16.0.36/22` |

> **LXC 200 trunk exception:** provider `bpg/proxmox` `0.111.1` does not expose
> the Proxmox LXC NIC `trunks` property. The rollback-controlled Access staging
> action in `infra/access/stage-access.sh` temporarily owns only `net1.trunks`.
> Do not apply this OpenTofu stack while that trunk is staged or committed; use
> the staging dry-run to detect drift after any future LXC 200 change.

VM `202` is deliberately stopped and excluded from automatic boot. Its
management NIC is on `vmbr1`, its trunk NIC is on `vmbr20`, and its
approved-egress uplink is `net2` on `vmbr0` at `172.16.0.36/22` with the default
route via `172.16.0.1`.

**The uplink shares an L2 broadcast domain with Proxmox management.** This is an
explicitly accepted deviation from the architecture plan's "must not use the
Proxmox management bridge" constraint, recorded in `NETWORK-ARCHITECTURE-PLAN.md`.
The host has a single physical NIC, and a second Hyper-V adapter added on
2026-08-11 was proven by packet capture to land on the same segment, so a
separate bridge would have provided no isolation. The accepted risk is that a
compromised Gateway can reach Proxmox management directly; the guest firewall
therefore exposes no service on the uplink beyond DHCP client replies. Revisit by
setting a VLAN ID on the Hyper-V adapter or moving it to an isolated vSwitch.

Do not start the VM until the guest's fail-closed nftables, DHCP, DNS, and proxy
configuration has been reconciled and validated. The backend renders that
configuration (`npm run render-gateway`), but no applier installs it yet, and
`squid -k parse` plus a confirmed Squid start remain outstanding gates.

Host bridges, DHCP, NAT, and forwarding are owned by
`scripts/setup-proxmox-host-network.sh`. The backend will own dynamic VNets and
group allocations; this root intentionally creates no VNet. Application
installation and secrets are outside OpenTofu. This pilot defines no backup
resources, extra LXC mount points, snapshots, or provisioners.

## Prerequisites

1. Apply and verify the host-network script.
2. Create a Proxmox API token with the privileges required to download LXC
   templates and manage containers, storage, and their power state.
3. Generate a dedicated SSH deployment key for the guests.
4. Install OpenTofu 1.8 or newer.

The provider uses only the Proxmox API for these resources; provider SSH access
is not required.

The template download resource specifically requires `Sys.Audit`, `Sys.Modify`,
and `Datastore.AllocateTemplate`. Verify the token's effective privileges on the
Proxmox host:

```sh
pveum user token list root@pam
pveum user token permissions root@pam <token-id>
```

Use the token ID shown by the list command. The output must include
`Sys.Audit` and `Sys.Modify` on `/`, plus `Datastore.AllocateTemplate` on
`/storage/local` or an inherited parent path. An HTTP 401 from
`query-url-metadata` means these Proxmox ACLs are missing; it does not mean the
public template URL requires credentials.

Append missing privileges to the custom role already assigned to the user and
token; replace `Terraform` when that role has a different ID:

```sh
pveum role modify Terraform --append 1 \
   --privs "Sys.Audit Sys.Modify Datastore.AllocateTemplate"
```

For a privilege-separated token, effective permissions are the intersection of
the backing user's and token's ACLs. Because this token belongs to `root@pam`,
the backing user is already unrestricted; verify the token with the command
above after changing its assigned role.

## Initialize and plan

```sh
cd infra/opentofu/lab
cp terraform.tfvars.example terraform.tfvars
tofu init
tofu fmt -check
tofu validate
tofu plan -out=.state/lab.tfplan
```

Do not apply until the plan contains only the expected persistent resources. It
must not contain a VNet. The Gateway base milestone has provisioned the
checksum-pinned Ubuntu cloud image and stopped VM `202`; subsequent plans must
not recreate either resource or change the VM's power state, boot policy,
storage, initialization, or two-NIC topology. Local state, plans, and
`terraform.tfvars` are ignored; `.terraform.lock.hcl` is intentionally committed
after `tofu init`.

VM `202` sets `agent.wait_for_ip.disabled = true`, so refresh and apply do not
wait for guest-reported addresses while the base remains stopped. With
`bpg/proxmox` `0.111.1`, a subsequent plan can still report an in-place update
whose only changes are `ipv4_addresses`, `ipv6_addresses`, and
`network_interface_names` changing from empty lists to values known after
apply. These are computed guest-agent outputs and this exact three-field diff is
provider plan-time noise, not infrastructure drift. Audit the machine-readable
plan to confirm that no other field or resource changes, then leave it unapplied;
repeated apply does not converge it. Any additional change remains actionable
and must be investigated.

Set `proxmox_api_token` in the ignored `terraform.tfvars` file before planning.
The token is marked sensitive to redact it from CLI output, but tfvars remains a
plain-text secret file and must not be committed.

## Apply

```sh
tofu apply .state/lab.tfplan
```

For the network stage, apply the host bridge before creating `labzone`:

```sh
./scripts/setup-proxmox-host-network.sh \
   --host 172.16.0.34 \
   --interactive-auth \
   --forward-app-ports \
   --apply \
   --replace-drifted-files \
   --confirmation "APPLY NETWORK 172.16.0.34 vmbr1 vmbr20"

cd infra/opentofu/lab
tofu plan -out=.state/network-stage.tfplan
tofu apply .state/network-stage.tfplan
```

The host script preserves untagged legacy `10.10.20.0/24` traffic while enabling
VLAN filtering and VLAN IDs `2000-2255` on `vmbr20`. Review the OpenTofu plan
before applying: existing LXCs must be no-op, and the only creates at this stage
must be `proxmox_sdn_zone_vlan.lab` and `proxmox_sdn_applier.lab`.

The default Ubuntu rootfs URL and SHA-512 checksum identify Proxmox's Ubuntu
22.04 standard LXC appliance, version `22.04-1`. The public appliance endpoint
uses HTTP, so checksum verification is required. Update both values together
when deliberately rolling to another template release.

The Gateway image URL uses Ubuntu's immutable Noble `release-20260801` path and
its published SHA-256 digest. Update the URL, filename date, and checksum
together when deliberately rolling the Gateway base image.