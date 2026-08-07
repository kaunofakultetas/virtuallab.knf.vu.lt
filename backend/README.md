Passwords can be hashed by running:

```bash
npm run hash-password -- --password "password123"
```

Create or reset a backend administrator by passing the password through the
environment:

```bash
read -s "ADMIN_PASSWORD?Admin password: "; printf '\n'
docker compose -f docker-compose.dev.yml exec \
	-e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
	backend npm run create-admin -- --vu-id 12345678
unset ADMIN_PASSWORD
```

Replace `12345678` with the numeric VU ID. The command also promotes an existing
user with the same ID to `admin`.

Optional logging environment variables:

- `LOGGING_LOKI_URL`: when set, backend logs are also sent to Grafana Loki through the `pino-loki` transport (set this to your Loki host URL, e.g. `http://localhost:3100`).
- `LOGGING_LOKI_USER` / `LOGGING_LOKI_PASS`

## Network Allocation

The allocator reserves VLANs `2000-2255` and their canonical
`10.200.<offset>.0/24` subnets in a single PostgreSQL transaction. It uses
transaction advisory lock `1447838018`, a target-row lock, and unique database
constraints; persisted allocation tuples are authoritative when desired state is
projected. Allocation moves a group from `planned` (or an unallocated `error`)
to `creating` and records the full desired-plan SHA-256 revision.

Applying `schema.sql` performs a preflight over existing `network_groups` data
before installing allocation constraints. Resolve any reported partial tuple,
out-of-pool VLAN, or allocation/lifecycle mismatch before deployment. The
allocator does not enable `active`, mutate Proxmox, or release reservations. A
live PostgreSQL simultaneous-allocation test remains required before the active
provisioning path is enabled.

## Proxmox Infrastructure Client

The typed client supports SDN VNet and subnet CRUD/application, persistent QEMU
and LXC network configuration, cluster firewall security groups and IPSets,
QEMU firewall rules/options, optimistic-concurrency digests, and typed task
completion. Existing `configVM` and boolean task-waiting methods remain as
compatibility wrappers; new infrastructure code should use the typed methods.

The HTTP contracts are tested against a local fixture only. Before enabling
reconciliation, verify the deployed API token has `SDN.Allocate`, VM
configuration/firewall, task, and audit privileges. Also confirm the deployed
Proxmox field set and whether `PUT /cluster/sdn` returns `null` or a task UPID.
Persistent LXC `trunks=` updates do not prove that a running host veth gained the
VLAN; reconciliation must verify and repair live bridge membership separately.

## Read-only Access Reconciliation

The dry-run reconciliation endpoint observes Access LXC `200` through a
dedicated, forced SSH command on its Proxmox host. It compares persistent LXC
`net1`, live `veth200i1` tagged bridge VLANs, and guest network policy. It does
not execute any mutation.

Install the root-owned observers on the Proxmox host:

```bash
install -o root -g root -m 0755 infra/access/observe_access.py \
	/usr/local/libexec/virtual-lab/observe_access.py
install -o root -g root -m 0755 infra/access/observe_access_forced_command.py \
	/usr/local/libexec/virtual-lab/observe_access_forced_command.py
```

Create a dedicated SSH key and principal. Configure its `authorized_keys` entry
with a forced command; replace `pve1` with the node name used by `pvesh` and
optionally constrain `from=` to the backend host address:

```text
restrict,command="PROXMOX_NODE_NAME=pve1 /usr/local/libexec/virtual-lab/observe_access_forced_command.py" ssh-ed25519 AAAA... access-observer
```

Place `id_ed25519` and a pinned `known_hosts` file in a host directory readable
by container UID `1001`. Set these production variables in `.env`:

```text
ACCESS_OBSERVER_CREDENTIALS_DIR=/absolute/host/path/to/access-observer
ACCESS_OBSERVER_HOST=pve1.example.internal
ACCESS_OBSERVER_PORT=22
# Set when connecting through a TCP proxy while known_hosts pins the real host.
ACCESS_OBSERVER_HOST_KEY_ALIAS=pve1.example.internal
ACCESS_OBSERVER_USER=access-observer
ACCESS_OBSERVER_COMMAND=virtual-lab-access-observe
```

The Compose file mounts that directory read-only at `/run/access-observer` and
sets the in-container identity and known-hosts paths. The remote command string
is only an SSH protocol argument; the forced `authorized_keys` command ignores
it. Strict host key checking, batch mode, disabled forwarding, bounded output,
and execution timeouts are always enabled. The API returns `503` when observer
configuration is incomplete.
