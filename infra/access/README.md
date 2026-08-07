# Access observation

## Backend forced observer

The backend reconciliation dry-run observes the Proxmox-owned and live portions
of Access state through a dedicated SSH principal. Install both root-owned
collectors on the Proxmox node:

```bash
install -o root -g root -m 0755 infra/access/observe_access.py \
	/usr/local/libexec/virtual-lab/observe_access.py
install -o root -g root -m 0755 infra/access/observe_access_forced_command.py \
	/usr/local/libexec/virtual-lab/observe_access_forced_command.py
```

Authorize the backend's public key with a fixed command. Replace `pve1` with the
actual node name returned by `pvesh get /nodes`. Add `from="ADDRESS"` before
`restrict` when the backend has a stable source address:

```text
restrict,command="PROXMOX_NODE_NAME=pve1 /usr/local/libexec/virtual-lab/observe_access_forced_command.py" ssh-ed25519 AAAA... access-observer
```

The forced command accepts only a bounded, versioned Access observation request.
It reads LXC `200` config through `pvesh`, verifies that the LXC is running,
reads only tagged VLAN membership from `veth200i1`, and executes the checked-in
guest collector through `pct exec`. It has no mutation operation or caller-
controlled command dispatch.

The backend SSH client additionally enforces batch mode, strict pinned host-key
checking, one identity, no agent or port forwarding, no local command, no TTY,
bounded output, and connection/execution timeouts. A failed or malformed Access
observation is persisted as a required failed reconciliation check; it does not
erase a healthy Proxmox VNet plan.

Run the read-only observation command as root inside Access LXC `200`:

```bash
sudo ./infra/access/observe-access.sh >access-observation.json
```

Root is needed to read the complete nftables ruleset, Docker networks, and
kernel connection tracking state. Conntrack preserves the original source
address before Docker destination NAT. When conntrack does not expose a matching
flow, the collector passively watches service packets for five seconds. The
capture is restricted to management interface `eth0`, before Docker destination
NAT. The command does not modify interfaces, sysctls, Docker, nftables,
containers, or files. A non-empty `errors` array means the observation is
incomplete and must fail readiness.

Inspect the current persistence owners through the Proxmox host before building
or running the first staging action:

```bash
./infra/access/inspect-access-persistence.sh \
	--host 172.16.0.34 \
	--interactive-auth
```

The inspector is read-only and accepts only the approved Proxmox host. Omit
`--interactive-auth` when SSH key authentication is configured. Its output must
confirm the Proxmox NIC definition, interfaces include mechanism, nftables
include mechanism, sysctl ownership, and service state. Do not design the apply
path from assumed Debian defaults.

Generate traffic through Entry Caddy while capturing an observation to prove
that connections to ports `8080` and `9443` arrive from API LXC
`10.10.10.100`. No active connection is reported as `unobserved`, not as proof
of the source policy.

## Generated configuration

The backend renderer produces complete, revision-marked content for:

- systemd-networkd `.netdev` and `.network` units for active VLAN
  subinterfaces, plus a drop-in that attaches them to PVE-owned `eth1`;
- sysctls enabling IPv4 forwarding and disabling IPv6; and
- an nftables table that protects Docker-published ports before DNAT and uses a
	default-drop forwarding chain.

Read-only inspection on 2026-08-07 confirmed that PVE generates
`/etc/systemd/network/eth0.network` and `eth1.network`, systemd-networkd is the
active network manager, and ifupdown is not installed. Generated configuration
therefore never replaces either PVE-owned base unit. Proxmox supports the
`trunks` property on an LXC NIC, although the pinned OpenTofu provider does not
expose it for container resources; the maintenance action must preserve the
complete existing `net1` value when setting its trunk allowlist.

The renderer does not replace the host input chain, because the approved SSH
administration source policy has not yet been established. It does restrict
published ports `8080` and `9443` to API LXC `10.10.10.100/32`, denies
lab-originated forwarding by default, and permits Docker bridge sources to
reach active lab subnets.

Do not stage or apply generated files until a complete observation from LXC
`200` confirms its Docker bridge CIDRs and the effective Caddy source address.
The first application must use a rollback timer during the maintenance window.

## Rollback-controlled VLAN 2000 staging

The first live action is additive: it retains `eth0` management and the legacy
`10.10.20.10/24` address on `eth1`, adds only trunk `2000`, installs the
revision-marked networkd/sysctl files, and loads only
`table inet virtual_lab_access`. It never reloads the monolithic
`/etc/nftables.conf`.

Run the read-only preflight first:

```bash
./infra/access/stage-access.sh \
	--host 172.16.0.34 \
	--interactive-auth
```

Then validate the generated bundle with the target LXC's nftables parser. This
uploads temporary files only under `/run` and does not create transaction state
or change persistent/runtime configuration:

```bash
./infra/access/stage-access.sh \
	--host 172.16.0.34 \
	--interactive-auth \
	--validate
```

During an approved maintenance window, stage with a ten-minute automatic
rollback:

```bash
./infra/access/stage-access.sh \
	--host 172.16.0.34 \
	--interactive-auth \
	--apply \
	--confirmation "STAGE ACCESS 172.16.0.34 LXC 200 VLAN 2000"
```

The first staged transaction on 2026-08-07 automatically rolled back after its
600-second timer. Status confirmed successful service execution, exact removal
of `trunks=2000`, removal of the VLAN address and managed nftables table, and
removal of all five managed files. This proves the automatic recovery path.

For the commit candidate, use the maximum 30-minute window so acceptance checks
are not rushed:

```bash
./infra/access/stage-access.sh \
	--host 172.16.0.34 \
	--interactive-auth \
	--rollback-seconds 1800 \
	--apply \
	--confirmation "STAGE ACCESS 172.16.0.34 LXC 200 VLAN 2000"
```

The command prints a transaction ID. Before its timer expires, verify
management and Guacamole reachability, API LXC access to ports `8080` and
`9443`, direct lab denial, and Docker-to-VLAN-2000 forwarding. Commit only that
transaction after all checks pass:

```bash
./infra/access/stage-access.sh \
	--host 172.16.0.34 \
	--interactive-auth \
	--status access-YYYYMMDDTHHMMSSZ-REVISION
```

Status is read-only and reports whether the transaction is armed, committed, or
rolled back along with the timer, `net1`, live host-veth trunk membership, VLAN
address, managed table, and files. Proxmox persists `trunks` without necessarily
updating an already-running veth, so apply explicitly reconciles that live bridge
membership and rollback removes it when it was absent from the saved `net1`.
Do not commit until an actual VLAN 2000 source has proved that direct access to
ports `8080` and `9443` is denied. Then commit only an armed transaction whose
acceptance checks passed:

```bash
./infra/access/stage-access.sh \
	--host 172.16.0.34 \
	--interactive-auth \
	--commit access-YYYYMMDDTHHMMSSZ-REVISION \
	--confirmation "STAGE ACCESS 172.16.0.34 LXC 200 VLAN 2000"
```

Until the pinned `bpg/proxmox` provider exposes LXC NIC `trunks`, this script is
the explicit owner of that single `net1` property. It reads the current complete
`net1`, appends the allowlist, and sends the Proxmox config digest with the
mutation. The rollback transaction stores and restores the exact preceding
value. Do not run `tofu apply` for LXC `200` while a trunk is staged or committed:
the current provider cannot represent and therefore cannot promise to preserve
that property. Re-run the dry-run after any OpenTofu change to LXC `200`.

Validate the checked-in VLAN 2000 fixture with a real Linux nftables parser:

```bash
./infra/access/validate-rendered-nftables.sh
```

The command renders the configuration, verifies its revision marker, and runs
`nft -c` in an ephemeral Alpine container with `NET_ADMIN`. The fixture uses the
Docker bridge CIDRs observed on Access. It is validation input only and does not
apply configuration to LXC `200`.

## Baseline observed on 2026-08-07

The read-only collector completed on LXC `200` without collection errors and
confirmed:

- `eth0` has the approved management address `10.10.10.50/24`;
- `eth1` still has the migration-gating legacy address `10.10.20.10/24`;
- PVE owns the base `eth0` and `eth1` systemd-networkd units;
- Docker bridge networks are `172.17.0.0/16` and `172.18.0.0/16`;
- IPv4 forwarding is enabled;
- IPv6 is still enabled and must be disabled during migration;
- the current nftables forward policy is permissive; and
- ports `8080` and `9443` are currently published on `0.0.0.0`.

The repository Compose definition now binds those ports to `10.10.10.50`, but
that change has not been applied to LXC `200`. A traffic-backed capture on
2026-08-07 proved that Guacamole traffic to port `8080` and web-proxy traffic to
port `9443` both arrive from API LXC `10.10.10.100`. The capture completed with
no collection errors, closing the Access service source-observation gate. On
the same date, Linux `nft -c` accepted the generated VLAN 2000 ruleset for
revision `dd6b276b38dde763f9650cab83bb055ea2cefd0d03f472c964e7884b1a51a5e0`,
closing the offline syntax gate. The first live transaction then proved
automatic rollback. Transaction
`access-20260807T095309Z-dd6b276b38dd` was committed after API service access,
VLAN 2000 transport, Docker-to-VLAN forwarding, and VLAN-origin denial on ports
`8080` and `9443` all passed. The temporary VLAN probe was removed afterward.