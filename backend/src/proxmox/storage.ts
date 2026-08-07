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