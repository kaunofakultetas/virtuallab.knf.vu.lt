// -----------------------------------------------------------
//  [*] Utils — instance helpers shared by the three lists
//
//  What the student dashboard, the instances page and the
//  admin instances page all have to agree on:
//
//    displayStatus   — the chip label, including the two
//                      lifecycle states that are not in
//                      `status`
//    isActionable    — whether to offer the row's buttons
//    copyInstanceIp  — the copy-IP action
//    networkLabel    — the network heading and detail
//
//  Used by:
//    - pages/Index.tsx, pages/Instances.tsx,
//      pages/admin/AdminInstances.tsx
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// displayStatus
// -----------------------------------------------------------
//
// What to show in the status chip. Two lifecycle facts live
// outside `status`, because the 15-second Proxmox status sync
// overwrites that column for every VM it sees and would erase
// anything written there:
//
//   provisioning — the row exists but the VM is still being
//                  cloned; without this it reads "stopped" and
//                  the UI offers a Start button for a machine
//                  that does not exist yet.
//   quarantined  — the VM may be running unfiltered; the
//                  backend refuses start and session, so the
//                  UI must not offer them either.
//
// Used by:
//   - pages/Index.tsx, pages/Instances.tsx,
//     pages/admin/AdminInstances.tsx
// -----------------------------------------------------------

export type DisplayStatus = Instance["status"] | "provisioning" | "quarantined";

export function displayStatus(instance: Instance): DisplayStatus {
    if (instance.quarantined) return "quarantined";
    if (instance.provisioning_started_at) return "provisioning";
    return instance.status ?? "unknown";
}








// -----------------------------------------------------------
// isActionable
// -----------------------------------------------------------
//
// Whether the power and connect buttons should be offered at
// all. A provisioning row has no VM behind it yet, and a
// quarantined one may be running unfiltered — the backend
// refuses start and session for both, so offering the buttons
// would only produce an error the user cannot act on.
//
// Used by:
//   - pages/Index.tsx, pages/Instances.tsx,
//     pages/admin/AdminInstances.tsx — the row action buttons
// -----------------------------------------------------------

export function isActionable(instance: Instance): boolean {
    return !instance.quarantined && !instance.provisioning_started_at;
}








// -----------------------------------------------------------
// copyInstanceIp
// -----------------------------------------------------------
//
// Fetches the guest's addresses, picks the internal one and
// puts it on the clipboard; every failure comes back as a
// message rather than a throw so callers just show it.
//
// Used by:
//   - pages/Instances.tsx, pages/admin/AdminInstances.tsx —
//     the copy-IP buttons. The student dashboard has none.
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// networkLabel
// -----------------------------------------------------------
//
// The network an instance sits on, as a heading and a
// detail line.
//
// An instance provisioned in `legacy` or `dry-run` mode, or
// one created before per-group VLANs existed, holds no
// allocation of its own and shares the lab bridge with
// everything else. That is worth saying plainly rather than
// rendering an empty cell the reader has to interpret.
//
// Used by:
//   - the network column on all three instance lists
// -----------------------------------------------------------

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
