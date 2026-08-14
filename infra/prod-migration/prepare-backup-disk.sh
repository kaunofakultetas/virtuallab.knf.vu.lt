#!/usr/bin/env bash
# Partition, format and mount a freshly attached disk as a backup target.
#
#     bash prepare-backup-disk.sh /dev/sdX                  # inspect only
#     bash prepare-backup-disk.sh /dev/sdX --confirm ERASE  # actually do it
#
# THIS DESTROYS EVERYTHING ON THE NAMED DEVICE. On a Proxmox host the cost of
# naming the wrong one is the VM store, so the default is a dry run and the
# guards below refuse anything that is visibly in use. They are not a substitute
# for reading the inspection output before you pass --confirm.
#
# Formats ext4 with no reserved blocks and a large-file inode ratio: a backup
# drive has no use for the 5% root reserve or for millions of inodes, and on a
# multi-terabyte disk that is tens of gigabytes back.

set -Eeuo pipefail

DEVICE="${1:-}"
CONFIRM=""
[[ "${2:-}" == "--confirm" ]] && CONFIRM="${3:-}"

MOUNTPOINT="${MOUNTPOINT:-/mnt/backup}"
LABEL="${LABEL:-pve-backup}"

if [[ -z "$DEVICE" ]]; then
    printf 'Usage: %s /dev/sdX [--confirm ERASE]\n' "$0" >&2
    exit 2
fi

fail() { printf '\nREFUSING: %s\n' "$*" >&2; exit 1; }

[[ -b "$DEVICE" ]] || fail "$DEVICE is not a block device"
[[ "$DEVICE" =~ [0-9]$ ]] && fail "$DEVICE looks like a partition; pass the whole disk (e.g. /dev/sdb)"

printf '=== the device you named ===\n'
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,SERIAL "$DEVICE"
printf '\n=== signatures currently on it (dry run, nothing removed) ===\n'
wipefs -n "$DEVICE" 2>/dev/null || echo "  (none)"

# --- guards -----------------------------------------------------------------
# Each refuses a specific way of destroying the host rather than the new disk.

root_src="$(findmnt -no SOURCE / || true)"
root_disk="$(lsblk -no PKNAME "$root_src" 2>/dev/null | head -1 || true)"
[[ -n "$root_disk" && "/dev/$root_disk" == "$DEVICE" ]] && fail "$DEVICE carries the root filesystem"

if lsblk -no MOUNTPOINT "$DEVICE" | grep -q '[^[:space:]]'; then
    printf '\nmounted filesystems on this device:\n'
    lsblk -no NAME,MOUNTPOINT "$DEVICE" | grep '[^[:space:]]$'
    fail "$DEVICE has something mounted; unmount it first if you are certain"
fi

if command -v pvs >/dev/null && pvs --noheadings -o pv_name 2>/dev/null | grep -q "^\s*${DEVICE}"; then
    fail "$DEVICE is an LVM physical volume — this is how local-lvm gets destroyed"
fi

if lsblk -no FSTYPE "$DEVICE" | grep -qE 'LVM2_member|linux_raid_member|zfs_member'; then
    fail "$DEVICE holds LVM/RAID/ZFS metadata; it is part of an existing storage stack"
fi

if command -v pvesm >/dev/null && pvesm status 2>/dev/null | tail -n +2 | awk '{print $1}' \
    | while read -r s; do pvesm path "$s" 2>/dev/null; done | grep -q "$DEVICE"; then
    fail "$DEVICE appears to back a configured Proxmox storage"
fi

size_bytes="$(blockdev --getsize64 "$DEVICE")"
(( size_bytes > 0 )) || fail "$DEVICE reports zero size"
printf '\nguards passed: not root, nothing mounted, no LVM/RAID/ZFS, not a PVE storage\n'
printf 'size: %s GiB\n' "$((size_bytes / 1024 / 1024 / 1024))"

if [[ "$CONFIRM" != "ERASE" ]]; then
    printf '\n=== DRY RUN ===\n'
    printf 'Nothing has been changed. Read the output above and confirm this is the\n'
    printf 'new disk — check the MODEL, SERIAL and SIZE against what you plugged in.\n\n'
    printf 'Then run:\n    bash %s %s --confirm ERASE\n' "$0" "$DEVICE"
    exit 0
fi

# --- destructive from here --------------------------------------------------
printf '\n=== partitioning %s ===\n' "$DEVICE"
wipefs -a "$DEVICE"
# GPT with a single partition spanning the disk. A partition table rather than a
# bare filesystem, so the disk is recognisable to anything that inspects it
# later and cannot be mistaken for unformatted space.
sgdisk --zap-all "$DEVICE" >/dev/null
sgdisk --new=1:0:0 --typecode=1:8300 --change-name=1:"$LABEL" "$DEVICE" >/dev/null
partprobe "$DEVICE"
# Wait for udev to finish creating the device node rather than guessing at a
# sleep: on a slow or busy host two seconds is not always enough, and the
# failure looks identical to the partition never being created.
udevadm settle --timeout=30 2>/dev/null || sleep 3

# Named directly first. `sdb` -> `sdb1`, NVMe `nvme0n1` -> `nvme0n1p1`.
PART=""
for candidate in "${DEVICE}1" "${DEVICE}p1"; do
    [[ -b "$candidate" ]] && { PART="$candidate"; break; }
done
# Fallback in LIST mode, not the default. Plain `lsblk` draws a tree, so the
# name column comes back as `\u251c\u2500sdb1` and every path built from it is
# nonsense -- which is exactly how this failed the first time.
if [[ -z "$PART" ]]; then
    PART="$(lsblk -lno NAME,TYPE "$DEVICE" | awk '$2=="part"{print "/dev/"$1; exit}')"
fi
[[ -b "$PART" ]] || fail "no partition appeared on $DEVICE (looked for ${DEVICE}1, ${DEVICE}p1, and lsblk -l)"
printf 'created %s\n' "$PART"

printf '\n=== formatting ext4 ===\n'
# -m 0        : no root reserve. That is 5% of the disk, pointless for backups.
# -T largefile4: one inode per 4 MiB. These are multi-gigabyte archives, so the
#               default inode count is wasted space and slower to create.
mkfs.ext4 -F -L "$LABEL" -m 0 -T largefile4 "$PART"

UUID="$(blkid -s UUID -o value "$PART")"
printf '\nUUID=%s\n' "$UUID"

printf '\n=== mounting at %s ===\n' "$MOUNTPOINT"
mkdir -p "$MOUNTPOINT"
# By UUID, never by /dev/sdX: device letters are assignment order and change
# when disks are added or removed. A backup drive that silently stops mounting
# is a backup you do not have.
if ! grep -q "$UUID" /etc/fstab; then
    printf 'UUID=%s  %s  ext4  defaults,noatime,nofail  0  2\n' "$UUID" "$MOUNTPOINT" >> /etc/fstab
    printf 'added to /etc/fstab (nofail: a missing drive will not block boot)\n'
fi
mount "$MOUNTPOINT"
df -h "$MOUNTPOINT"

printf '\n=== done ===\n'
printf 'Backup target ready at %s\n\n' "$MOUNTPOINT"
printf 'To let Proxmox write backups here directly:\n'
printf '    pvesm add dir backup --path %s --content backup\n\n' "$MOUNTPOINT"
printf 'Or point the pre-reinstall capture at it:\n'
printf '    bash backup-before-reinstall.sh %s\n' "$MOUNTPOINT"
