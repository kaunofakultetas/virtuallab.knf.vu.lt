import { metadata } from "@/utils/metadata";

export type NetworkMode = "legacy" | "dry-run" | "active";

export async function getNetworkMode(): Promise<NetworkMode> {
    const mode = await metadata.get<string>("settings.network.mode");
    if (mode === "legacy" || mode === "dry-run" || mode === "active") {
        return mode;
    }
    throw new Error(`Invalid network mode: ${String(mode)}`);
}