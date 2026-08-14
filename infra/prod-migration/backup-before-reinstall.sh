#!/usr/bin/env bash
# Full pre-reinstall capture of a Proxmox host to an attached drive.
#
#     bash backup-before-reinstall.sh /mnt/backup-drive
#
# Captures three things, and the second is the one people forget:
#
#   1. Every guest, as a compressed vzdump archive.
#   2. The host's own configuration, for REFERENCE. Read it while rebuilding;
#      do NOT restore it wholesale. Restoring /etc is how the mess you are
#      reinstalling to escape comes straight back.
#   3. A manifest with sizes and checksums, so "did it all copy" has an answer.
#
# It writes ONLY under the target directory. It does not touch the guests'
# disks, the storage configuration, or anything on the host.
#
# Guests are stopped for the dump by default: a stopped guest yields a
# consistent image, and everything here is about to be wiped anyway. Pass
# --snapshot to keep running guests up, which needs the guest agent for a
# consistent filesystem and is the weaker guarantee.

set -Eeuo pipefail

MODE=stop
if [[ "${1:-}" == "--snapshot" ]]; then MODE=snapshot; shift; fi

# Compression threads, and the window they each need.
#
# zstd's memory is roughly threads x window, so these two are not independent:
# 32 threads at --long=30 (1 GiB) wants somewhere near 80 GiB of RAM and will be
# OOM-killed on a host that is also running VMs. --long=27 (128 MiB) keeps 32
# threads to something like 15 GiB while giving up very little ratio, because
# the duplicate blocks in a VM image are mostly near each other.
THREADS="${THREADS:-32}"
LONG="${LONG:-27}"

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
    printf 'Usage: %s [--snapshot] <target-directory>\n' "$0" >&2
    exit 2
fi
[[ -d "$TARGET" ]] || { printf 'Target %s is not a directory\n' "$TARGET" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Deliberately NOT timestamped. Re-running must land in the same directory or
# the resume check below can never match, and a run interrupted by a full drive
# would restart from the first guest every time -- never getting further than
# the attempt before it.
OUT="$TARGET/proxmox-$(hostname)"
mkdir -p "$OUT/guests" "$OUT/host-reference"
MANIFEST="$OUT/MANIFEST.txt"

log() { printf '[backup] %s\n' "$*" | tee -a "$MANIFEST"; }

log "host      : $(hostname)"
log "version   : $(pveversion | head -1)"
log "started   : $STAMP"
log "mode      : $MODE"
log "zstd      : --ultra -22 --long=$LONG -T$THREADS"
log "host RAM  : $(free -g 2>/dev/null | awk '/^Mem:/{print $2" GiB total, "$7" GiB available"}')"
log "target    : $OUT"

# Refuse to start if the drive plainly cannot hold the data. Thin-pool usage is
# the closest available estimate of real bytes; compression will beat it, but
# running out of space halfway through a pre-wipe backup is the one failure
# that cannot be retried later.
avail_kib="$(df -Pk "$TARGET" | awk 'NR==2{print $4}')"
used_kib="$(pvesm status 2>/dev/null | awk '/lvmthin|dir/ {u+=$5} END{print u+0}')"
log "target free: $((avail_kib/1024/1024)) GiB, guests use about $((used_kib/1024/1024)) GiB uncompressed"
# A third is roughly what zstd -22 achieves on VM images that have had their
# free space zeroed; without zeroing it is closer to two thirds, because deleted
# data is indistinguishable from random and does not compress.
if (( avail_kib < used_kib / 3 )); then
    if [[ "${FORCE:-}" != "1" ]]; then
        log "REFUSING: target holds $((avail_kib/1024/1024)) GiB, guests are about $((used_kib/1024/1024)) GiB."
        log "Even maximum compression is unlikely to fit."
        log ""
        log "Either zero-fill the guests' free space first (much the biggest win),"
        log "back up fewer guests with ONLY=\"9000 9002 9004 101 102\", or override"
        log "with FORCE=1 and accept that it may stop partway. It is resumable:"
        log "rerun and it skips whatever already verified."
        exit 1
    fi
    log "WARNING: proceeding under FORCE=1; this may not fit."
fi

log ""
log "=== host configuration (reference only — do not restore wholesale) ==="
# Network is the one that strands you: the campus address and bridge layout
# have to be retyped by hand on the fresh install.
cp -a /etc/network/interfaces "$OUT/host-reference/" 2>/dev/null || true
cp -a /etc/hosts /etc/hostname /etc/resolv.conf "$OUT/host-reference/" 2>/dev/null || true
# The host answers DNS on the lab bridges today; whatever provides that has to
# be reinstated or deliberately dropped.
cp -a /etc/dnsmasq.conf "$OUT/host-reference/" 2>/dev/null || true
cp -ar /etc/dnsmasq.d "$OUT/host-reference/" 2>/dev/null || true
# /etc/pve is the cluster filesystem: guest configs, storage, users, firewall.
tar -C /etc -czf "$OUT/host-reference/etc-pve.tar.gz" pve 2>/dev/null || true
# Guest configs separately as well, so they can be read without unpacking.
mkdir -p "$OUT/host-reference/guest-configs"
cp -a /etc/pve/qemu-server/*.conf "$OUT/host-reference/guest-configs/" 2>/dev/null || true
cp -a /etc/pve/lxc/*.conf "$OUT/host-reference/guest-configs/" 2>/dev/null || true
# Authorized keys and host identity: the host key changes on reinstall, so
# every known_hosts pointing at this box needs updating afterwards.
cp -a /root/.ssh/authorized_keys "$OUT/host-reference/" 2>/dev/null || true
# Storage sizing, so the new install can be given a comparable layout.
{ pvesm status; echo; lsblk; echo; vgs; echo; lvs; } > "$OUT/host-reference/storage-layout.txt" 2>/dev/null || true
{ crontab -l 2>/dev/null; echo "--- systemd units ---"; systemctl list-unit-files --state=enabled 2>/dev/null; } \
    > "$OUT/host-reference/scheduled-and-units.txt" || true
{ apt-mark showmanual 2>/dev/null; } > "$OUT/host-reference/manually-installed-packages.txt" || true
log "captured network, /etc/pve, guest configs, storage layout, enabled units, package list"

log ""
log "=== guests ==="
mapfile -t VMIDS < <(qm list 2>/dev/null | awk 'NR>1{print $1}')
mapfile -t CTIDS < <(pct list 2>/dev/null | awk 'NR>1{print $1}')
log "QEMU: ${VMIDS[*]:-none}"
log "LXC : ${CTIDS[*]:-none}"

dump_one() {
    local id="$1" kind="$2"
    local name
    name="$(qm config "$id" 2>/dev/null | sed -n 's/^name: //p')"
    [[ -n "$name" ]] || name="$(pct config "$id" 2>/dev/null | sed -n 's/^hostname: //p')"
    log "--- $kind/$id ${name:-} ---"
    # Resumable. Filling the drive halfway through is the expected failure here,
    # and restarting from the first guest each time would make it unfixable:
    # you would never get further than the attempt before.
    if [[ -s "$OUT/guests/$id.vma.zst" ]] && zstd -t "$OUT/guests/$id.vma.zst" 2>/dev/null; then
        log "    already present and verified, skipping"
        return 0
    fi
    # --compress 0 with an external zstd: vzdump's own zstd has no level control
    # at all (its --zstd flag sets THREADS, not level), so maximum ratio has to
    # be reached in the pipe. --ultra -22 is the top of what zstd offers; on a
    # one-shot archive the extra CPU time is free.
    if vzdump "$id" --mode "$MODE" --compress 0 --stdout 2>>"$OUT/vzdump.log" \
        | zstd --ultra -22 "--long=$LONG" "-T$THREADS" -q -o "$OUT/guests/$id.vma.zst" -f; then
        local size
        size="$(stat -c %s "$OUT/guests/$id.vma.zst")"
        log "    wrote $((size/1024/1024)) MiB"
        # Verified now, while the source still exists. A backup nobody has read
        # back is a hope, and after the wipe it is the only copy.
        if zstd -t "$OUT/guests/$id.vma.zst" 2>/dev/null; then
            log "    integrity OK"
        else
            log "    INTEGRITY CHECK FAILED — do not wipe this host"
            return 1
        fi
        sha256sum "$OUT/guests/$id.vma.zst" | awk '{print "    sha256 " $1}' | tee -a "$MANIFEST" >/dev/null
    else
        log "    DUMP FAILED — do not wipe this host"
        return 1
    fi
}

wanted() {
    [[ -z "${ONLY:-}" ]] && return 0
    for w in $ONLY; do [[ "$w" == "$1" ]] && return 0; done
    return 1
}

failed=0
for id in "${VMIDS[@]:-}"; do
    [[ -n "$id" ]] || continue
    wanted "$id" || { log "--- qemu/$id skipped (not in ONLY) ---"; continue; }
    dump_one "$id" qemu || failed=1
    # Reported after every guest, so a drive that will not fit says so early
    # rather than at the end of a multi-hour run.
    log "    drive now $(df -Ph "$TARGET" | awk 'NR==2{print $4}') free"
done
for id in "${CTIDS[@]:-}"; do
    [[ -n "$id" ]] || continue
    wanted "$id" || { log "--- lxc/$id skipped (not in ONLY) ---"; continue; }
    dump_one "$id" lxc || failed=1
done

log ""
log "=== result ==="
du -sh "$OUT" | awk '{print "total: " $1}' | tee -a "$MANIFEST" >/dev/null
sync
if (( failed )); then
    log "ONE OR MORE GUESTS FAILED. Do not reinstall until every line above says integrity OK."
    exit 1
fi
log "every guest dumped and verified"
log ""
log "Before you wipe, restore ONE guest to a spare VMID on this host and boot it:"
log "    zstd -dc $OUT/guests/9000.vma.zst | qmrestore - 8999"
log "    qm start 8999 && qm status 8999"
log "That is the only evidence the archives are actually restorable."
