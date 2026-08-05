# OpenTofu lab infrastructure

This root manages only the Ubuntu LXC template and two persistent unprivileged
containers on Proxmox:

| VMID | Name | CPU | RAM | Root disk | Networks |
| --- | --- | --- | --- | --- | --- |
| 200 | `guacamole` | 4 | 10 GB | 32 GB | `10.10.10.50/24`, `10.10.20.10/24` |
| 201 | `api-docker` | 4 | 6 GB | 32 GB | `10.10.10.100/24` |

Host bridges, DHCP, NAT, and forwarding are owned by
`scripts/setup-proxmox-host-network.sh`. Application installation and secrets
are intentionally outside OpenTofu. This pilot defines no backup resources,
extra LXC mount points, snapshots, or provisioners.

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

Do not apply until the plan contains exactly one template download and the two
expected LXC creations. Local state, plans, and `terraform.tfvars` are ignored;
`.terraform.lock.hcl` is intentionally committed after `tofu init`.

Set `proxmox_api_token` in the ignored `terraform.tfvars` file before planning.
The token is marked sensitive to redact it from CLI output, but tfvars remains a
plain-text secret file and must not be committed.

## Apply

```sh
tofu apply .state/lab.tfplan
```

The default Ubuntu rootfs URL and SHA-512 checksum identify Proxmox's Ubuntu
22.04 standard LXC appliance, version `22.04-1`. The public appliance endpoint
uses HTTP, so checksum verification is required. Update both values together
when deliberately rolling to another template release.