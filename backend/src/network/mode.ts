// -----------------------------------------------------------
//  [*] Network — the operating mode switch
//
//  Reads settings.network.mode and refuses anything but the
//  three known values: legacy (shared bridge, no isolation),
//  dry-run (plan is computed and logged, VMs still land on
//  the shared bridge), active (real per-group VLAN
//  isolation).
//
//  Used by:
//    - instances.route.ts — on every VM create
//    - attachment.ts, teardown.ts, readiness.ts,
//      drift-reconciler.ts
// -----------------------------------------------------------

import { metadata } from "@/utils/metadata";

export type NetworkMode = "legacy" | "dry-run" | "active";

export async function getNetworkMode(): Promise<NetworkMode> {
    const mode = await metadata.get<string>("settings.network.mode");
    if (mode === "legacy" || mode === "dry-run" || mode === "active") {
        return mode;
    }
    throw new Error(`Invalid network mode: ${String(mode)}`);
}
