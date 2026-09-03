// -----------------------------------------------------------
//  [*] Proxmox — storage capacity guards for cloning
//
//  Two pure helpers that stop an instance clone before it
//  fills a datastore: find which storage the template's boot
//  disk lives on, then require a configured reserve of free
//  space there.
//
//  Used by:
//    - instances.controller.ts — before every clone
//    - test/instance-storage.test.ts
// -----------------------------------------------------------


// -----------------------------------------------------------
// getBootDiskStorage
// -----------------------------------------------------------
//
// Reads the template config's boot order (falling back to
// scsi0) and returns the storage half of that disk's volume
// ID ("local-lvm:vm-100-disk-0" → "local-lvm"). Throws when
// the boot disk cannot be resolved — a clone must never
// guess where it will land.
//
// Used by:
//   - instances.controller.ts (with assertStorageCapacity)
// -----------------------------------------------------------

export function getBootDiskStorage(config: Record<string, unknown>): string {
    const bootOrder = typeof config.boot === "string"
        ? config.boot.match(/(?:^|;)order=([^;]+)/)?.[1]
        : undefined;
    const bootDisk = bootOrder?.split(";")[0]?.split(",")[0] ?? "scsi0";
    const volume = config[bootDisk];
    if (typeof volume !== "string") {
        throw new Error(`Template boot disk ${bootDisk} is not configured`);
    }
    const storage = volume.split(":", 1)[0];
    if (!storage) {
        throw new Error(`Cannot determine storage from template boot disk ${bootDisk}`);
    }
    return storage;
}








// -----------------------------------------------------------
// assertStorageCapacity
// -----------------------------------------------------------
//
// Throws unless the storage is active, enabled and holds at
// least reserveBytes of free space. The error message quotes
// GiB figures because it travels to the UI as-is.
//
// Used by:
//   - instances.controller.ts (after getBootDiskStorage)
// -----------------------------------------------------------

export function assertStorageCapacity(
    storage: string,
    status: { active: number; enabled: number; avail: number },
    reserveBytes: number,
): void {
    if (status.active !== 1 || status.enabled !== 1) {
        throw new Error(`Proxmox storage ${storage} is not active and enabled`);
    }
    if (!Number.isFinite(status.avail) || status.avail < reserveBytes) {
        const availableGiB = Math.max(0, status.avail) / 1024 ** 3;
        const reserveGiB = reserveBytes / 1024 ** 3;
        throw new Error(
            `Proxmox storage ${storage} has ${availableGiB.toFixed(2)} GiB available; ` +
            `${reserveGiB.toFixed(2)} GiB is required before cloning`,
        );
    }
}
