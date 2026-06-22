import axios from "axios";
import { getErrorMessage } from "@/utils/errors";

type CopyIpResult =
    | { ok: true; ip: string }
    | { ok: false; message: string };

export async function copyInstanceIp(instanceId: number): Promise<CopyIpResult> {
    try {
        const res = await axios.get<string[]>(`/api/instances/${instanceId}/ip`);
        const ip = res.data.find((a) => a.startsWith("10.10."));
        if (!ip) {
            return {
                ok: false,
                message: "No internal IP found (10.10.x.x). Is the VM running?",
            };
        }
        await navigator.clipboard.writeText(ip);
        return { ok: true, ip };
    } catch (err) {
        return { ok: false, message: getErrorMessage(err, "Failed to get IP.") };
    }
}
