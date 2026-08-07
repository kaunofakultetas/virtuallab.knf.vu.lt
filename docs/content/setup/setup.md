---
slug: /setup
title: Setup
description: How to set up the project
---

# Setup

This section will guide you through the process of setting up the project.

## Prerequisites

You need:

- Proxmox VE at `172.16.0.34`, with root SSH access
- OpenTofu 1.8 or newer on the deployment workstation
- a Proxmox API token allowed to manage LXC containers, storage, and power state
- a dedicated SSH public key for the two LXCs

The API token must include `Sys.Audit` and `Sys.Modify` on `/`, and
`Datastore.AllocateTemplate` on `/storage/local` or an inherited parent path.
Check its effective permissions on the Proxmox host with:

```bash
pveum user token list root@pam
pveum user token permissions root@pam <token-id>
```

Use the token ID shown by the list command; `tokenid` is not a literal token
name.

If those privileges are absent, append them to the custom role already assigned
to the user and token, replacing `Terraform` when the role ID differs:

```bash
pveum role modify Terraform --append 1 \
	--privs "Sys.Audit Sys.Modify Datastore.AllocateTemplate"
```

Privilege-separated tokens receive only the intersection of the backing user's
and token's ACLs. Since this token belongs to `root@pam`, the backing user is
already unrestricted; verify the token again after changing its assigned role.

## Installation

Run every workstation command below from the repository root unless the command
changes directory explicitly.

### 1. Configure the Proxmox host network

Preview the managed bridges, DHCP, NAT, and forwarding configuration:

```bash
./scripts/setup-proxmox-host-network.sh \
	--host 172.16.0.34 \
	--interactive-auth \
	--dry-run
```

Apply it after reviewing the output:

```bash
./scripts/setup-proxmox-host-network.sh \
	--host 172.16.0.34 \
	--interactive-auth \
	--apply \
	--confirmation 'APPLY NETWORK 172.16.0.34 vmbr1 vmbr20'
```

Add `--forward-app-ports` to both commands when the Proxmox host should forward
TCP `80`, `443`, and `8888`, plus UDP `443`, to `10.10.10.100`. Omit
`--interactive-auth` when root SSH key authentication is configured.
When reconciling an existing host, repeat the same ingress mode used previously;
omitting `--forward-app-ports` removes those managed forwarding rules.

The script refuses to overwrite a managed file when its content has changed and
prints a unified diff of the current and desired versions. Review that diff. If
the desired version is correct, repeat the apply command with
`--replace-drifted-files`. This option only works with `--apply`, still requires
the confirmation phrase, and never replaces an unmarked file.

### 2. Configure the OpenTofu environment

Create the local variables file:

```bash
cd infra/opentofu/lab
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` and set:

- `proxmox_endpoint` to the Proxmox API URL, including HTTPS and port `8006`
- `proxmox_api_token` to the API token in `user@realm!token=secret` format
- `proxmox_insecure` to `true` only when Proxmox uses an untrusted certificate
- `node_name` to the Proxmox node name shown by `pvesh get /nodes`
- `guest_ssh_public_key` to the dedicated public key installed in both LXCs
- storage IDs only when they differ from `local` and `local-lvm`

`terraform.tfvars` is ignored by Git, but it contains the API token in plain
text. Keep its permissions restricted and never commit or share it.

Initialize, validate, and create a saved plan:

```bash
tofu init
tofu fmt -check
tofu validate
tofu plan -out=.state/lab.tfplan
```

The plan must contain one Ubuntu template download and exactly two LXC
creations: `200` (`guacamole`) and `201` (`api-docker`). Apply that reviewed
plan:

```bash
tofu apply .state/lab.tfplan
cd ../../..
```

OpenTofu state, saved plans, and `terraform.tfvars` stay local and are ignored
by Git. Commit `.terraform.lock.hcl`.

### 3. Deploy Guacamole

Run the remaining deployment commands as `root` on the Proxmox host. Download
the lifecycle script, push it into LXC `200`, then let it install Docker and
clone the repository into `/srv/virtual-proxmox-lab`:

```bash
curl -fsSL \
	https://raw.githubusercontent.com/kaunofakultetas/virtuallab.knf.vu.lt/main/scripts/manage-lxc-workload.sh \
	-o /tmp/manage-lxc-workload.sh
pct push 200 /tmp/manage-lxc-workload.sh /tmp/manage-lxc-workload.sh \
	--perms 0755
pct exec 200 -- /tmp/manage-lxc-workload.sh install \
	--role guacamole \
	--repository https://github.com/kaunofakultetas/virtuallab.knf.vu.lt.git
```

### 4. Deploy the application stack

Push the same lifecycle script into LXC `201` and install the checkout. This
command stops before Compose startup because the application `.env` does not
exist yet:

```bash
pct push 201 /tmp/manage-lxc-workload.sh /tmp/manage-lxc-workload.sh \
	--perms 0755
pct exec 201 -- /tmp/manage-lxc-workload.sh install \
	--role api-docker \
	--repository https://github.com/kaunofakultetas/virtuallab.knf.vu.lt.git
```

Create the application environment from the documented template, then enter the
container to edit it:

```bash
pct exec 201 -- cp /srv/virtual-proxmox-lab/backend/.env.example \
	/srv/virtual-proxmox-lab/.env
pct exec 201 -- chmod 600 /srv/virtual-proxmox-lab/.env
pct enter 201
vi /srv/virtual-proxmox-lab/.env
exit
```

At minimum, replace `POSTGRES_PASSWORD`, `BACKEND_JWT_SECRET`, `PROXMOX_AUTH_TOKEN`,
`GUACAMOLE_USER`, `GUACAMOLE_PASS`, and `GUACAMOLE_PUBLIC_URL`. Review all
domain, SAML, Loki, and TLS values for the deployment. The backend intentionally
uses `exit:8006` for Proxmox and `exit:8080` for Guacamole because it runs on an
internal Docker network.

The reconciliation dry-run also requires a dedicated SSH identity for read-only
Access observation. On the deployment host, create a directory containing the
private key as `id_ed25519` and the pinned Proxmox host key as `known_hosts`.
The directory and files must be readable by container UID `1001`; keep the
private key inaccessible to other users. Add the following values to `.env`:

```text
ACCESS_OBSERVER_CREDENTIALS_DIR=/absolute/host/path/to/access-observer
ACCESS_OBSERVER_HOST=pve1.example.internal
ACCESS_OBSERVER_PORT=22
# Set when connecting through a TCP proxy while known_hosts pins the real host.
ACCESS_OBSERVER_HOST_KEY_ALIAS=pve1.example.internal
ACCESS_OBSERVER_USER=access-observer
ACCESS_OBSERVER_COMMAND=virtual-lab-access-observe
```

Install the forced observer and restricted `authorized_keys` entry on the
Proxmox node as documented in `infra/access/README.md`. Compose mounts the
credentials directory read-only. The reconciliation endpoint returns `503`
instead of starting SSH when this configuration is incomplete.

For this test network, add `CADDY_IP_HTTP_HOST=172.16.0.34` to `.env` to serve
the application over plain HTTP at `http://172.16.0.34`. Leave the variable
unset in production; requests to the server IP then use the fallback site.
Set `GUACAMOLE_PUBLIC_URL=http://172.16.0.34/guac` when testing Guacamole
sessions through the IP endpoint.

Start the stack and inspect its status:

```bash
pct exec 201 -- /tmp/manage-lxc-workload.sh update --role api-docker
pct exec 201 -- /tmp/manage-lxc-workload.sh status --role api-docker
```

For later deployments, use the lifecycle script from the checkout:

```bash
pct exec 201 -- \
	/srv/virtual-proxmox-lab/scripts/manage-lxc-workload.sh update \
		--role api-docker
```

See [OpenTofu lab infrastructure](https://github.com/kaunofakultetas/virtuallab.knf.vu.lt/blob/main/infra/opentofu/lab/README.md) for
variable definitions, resource ownership, and recovery details.
