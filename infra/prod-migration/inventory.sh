#!/usr/bin/env bash
# Read-only inventory of a Proxmox host, run before the network migration.
#
# It MUTATES NOTHING: every command here is a read. Run it on the production
# Proxmox host as root and send back the output.
#
#     bash inventory.sh > prod-inventory.txt
#
# Secrets are masked. It prints environment variable NAMES and never values,
# and public keys are truncated. Read the output before sending it on; if
# anything looks sensitive for your institution, cut it.
#
# The point is to answer three questions the migration depends on:
#   1. What already exists that must survive untouched?
#   2. Which prerequisites are present, and which need building?
#   3. What would the datacenter firewall do to guests we do not own?

set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "Identity"
hostname
pveversion 2>/dev/null | head -1
printf 'node name candidates: '; ls /etc/pve/nodes 2>/dev/null | tr '\n' ' '; echo

section "Guests that must survive (templates, prep VMs, everything)"
echo "--- QEMU ---"
qm list 2>/dev/null
echo "--- LXC ---"
pct list 2>/dev/null
echo "--- which QEMU guests are templates ---"
for id in $(qm list 2>/dev/null | awk 'NR>1{print $1}'); do
    if qm config "$id" 2>/dev/null | grep -q '^template: 1'; then
        printf '  %s TEMPLATE %s\n' "$id" "$(qm config "$id" | sed -n 's/^name: //p')"
    fi
done

section "Guest network attachment (what the migration must not disturb)"
for id in $(qm list 2>/dev/null | awk 'NR>1{print $1}'); do
    printf '  qemu/%s: ' "$id"
    qm config "$id" 2>/dev/null | grep -E '^net[0-9]+:' | tr '\n' ' '
    echo
done
for id in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do
    printf '  lxc/%s: ' "$id"
    pct config "$id" 2>/dev/null | grep -E '^net[0-9]+:' | tr '\n' ' '
    echo
done

section "Bridges and VLAN awareness"
# vlan_aware matters: the lab bridge must carry tagged frames, and turning it on
# touches a bridge existing guests may already sit on.
grep -E '^(auto|iface|\s+bridge|\s+address|\s+vlan)' /etc/network/interfaces 2>/dev/null
echo "--- live bridge VLAN filtering ---"
for br in $(ls /sys/class/net | grep -E '^vmbr'); do
    printf '  %s vlan_filtering=%s\n' "$br" "$(cat "/sys/class/net/$br/bridge/vlan_filtering" 2>/dev/null || echo '?')"
done

section "SDN (zones, vnets) — must be empty of lab* before migration"
pvesh get /cluster/sdn/zones --output-format json 2>/dev/null
pvesh get /cluster/sdn/vnets --output-format json 2>/dev/null

section "Firewall state — the highest-risk step"
echo "--- cluster ---"
pvesh get /cluster/firewall/options --output-format json 2>/dev/null
echo "--- node rules (must admit the orchestrator BEFORE enabling) ---"
pvesh get /nodes/$(hostname)/firewall/rules --output-format json 2>/dev/null
echo "--- per-guest firewall files (a guest with none is unaffected by enabling) ---"
ls -la /etc/pve/firewall/ 2>/dev/null
echo "--- NIC-level firewall flags on existing guests ---"
for id in $(qm list 2>/dev/null | awk 'NR>1{print $1}'); do
    qm config "$id" 2>/dev/null | grep -E '^net[0-9]+:.*firewall=1' >/dev/null && echo "  qemu/$id has firewall=1 on a NIC"
done

section "Host listeners and forwarding"
ss -Hlnt 2>/dev/null | awk '{print $4}' | sort -u
printf 'ip_forward=%s\n' "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)"

section "Storage headroom (cloning needs room per VM)"
pvesm status 2>/dev/null

section "SSH principals already installed (keys truncated)"
sed -E 's/(ssh-[a-z0-9]+ )[A-Za-z0-9+/=]{16}[A-Za-z0-9+/=]*/\1<KEY>/' /root/.ssh/authorized_keys 2>/dev/null

section "Orchestrator forced commands present?"
ls -la /usr/local/libexec/virtual-lab/ 2>/dev/null || echo "  (none installed)"

section "Application stack"
for d in /srv/virtual-proxmox-lab /opt/virtual-proxmox-lab; do
    [ -d "$d" ] && { echo "  stack at $d"; git -C "$d" log --oneline -1 2>/dev/null; }
done
for id in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do
    pct exec "$id" -- sh -lc 'test -d /srv/virtual-proxmox-lab && echo "  stack inside lxc/'"$id"'" && git -C /srv/virtual-proxmox-lab log --oneline -1 2>/dev/null' 2>/dev/null
done

section "Stack configuration KEYS ONLY (no values)"
for id in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do
    pct exec "$id" -- sh -lc 'test -f /srv/virtual-proxmox-lab/.env && sed -E "s/=.*/=<set>/" /srv/virtual-proxmox-lab/.env' 2>/dev/null
done

section "Network mode currently recorded in the database"
for id in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do
    pct exec "$id" -- sh -lc 'cd /srv/virtual-proxmox-lab 2>/dev/null && docker compose exec -T postgres psql -Atq -U postgres -d backend_db -c "SELECT key || E'"'"' = '"'"' || value FROM metadata WHERE key LIKE '"'"'settings.network%'"'"'" 2>/dev/null' 2>/dev/null
    pct exec "$id" -- sh -lc 'cd /srv/virtual-proxmox-lab 2>/dev/null && docker compose exec -T postgres psql -Atq -U postgres -d backend_db -c "SELECT count(*) || '"'"' network_groups, '"'"' || (SELECT count(*) FROM instances) || '"'"' instances'"'"' FROM network_groups" 2>/dev/null' 2>/dev/null
done

printf '\n===== inventory complete =====\n'
