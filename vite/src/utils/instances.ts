import axios from "axios";
import { getErrorMessage } from "@/utils/errors";
import type { Instance } from "@/types/instances";

type CopyIpResult =
    | { ok: true; ip: string }
    | { ok: false; message: string };

// A student VM's internal address depends on the network mode, which the client
// cannot see:
//   10.200.<vlan - 2000>.0/24  one per isolated group (backend config.ts)
//   10.10.0.0/16               the legacy flat lab network
// Matching 10/8 covers both without teaching the client the VLAN arithmetic, and
// still excludes what else a guest agent reports: Docker bridges on 172.17/172.18
// and any campus address on 172.16/12. The endpoint returns every IPv4 the agent
// sees, unfiltered, so this predicate is the only thing narrowing it.
const INTERNAL_IPV4 = /^10\./;

export async function copyInstanceIp(instanceId: number): Promise<CopyIpResult> {
    try {
        const res = await axios.get<string[]>(`/api/instances/${instanceId}/ip`);
        const ip = res.data.find((a) => INTERNAL_IPV4.test(a));
        if (!ip) {
            return {
                ok: false,
                message: "No internal IP found. Is the VM running?",
            };
        }
        await navigator.clipboard.writeText(ip);
        return { ok: true, ip };
    } catch (err) {
        return { ok: false, message: getErrorMessage(err, "Failed to get IP.") };
    }
}

/**
 * The network an instance sits on, as a heading and a detail line.
 *
 * An instance provisioned in `legacy` or `dry-run` mode, or one created before
 * per-group VLANs existed, holds no allocation of its own and shares the lab
 * bridge with everything else. That is worth saying plainly rather than
 * rendering an empty cell the reader has to interpret.
 */
export const networkLabel = (instance: Instance): { primary: string; detail: string } => {
    if (instance.network_group_subnet_cidr === null) {
        return {
            primary: instance.profile_name ?? "Shared network",
            detail: "Shared lab bridge",
        };
    }
    return {
        primary:
            instance.profile_name ?? `Group ${instance.network_group_id}`,
        detail: `${instance.network_group_subnet_cidr} · VLAN ${instance.network_group_vlan_tag}`,
    };
};
