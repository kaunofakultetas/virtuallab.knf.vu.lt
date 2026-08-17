import axios from "axios";
import { getErrorMessage } from "@/utils/errors";

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
