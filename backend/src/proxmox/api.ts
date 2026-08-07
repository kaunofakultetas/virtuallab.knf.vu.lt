import { Agent, fetch } from "undici";
import {
    ProxmoxApiError,
    ProxmoxApiResponse,
    ProxmoxClientConfig,
    ProxmoxHTTPMethod,
    ProxmoxNodeTaskStatus,
    ProxmoxNodeNetwork,
    ProxmoxNodeVM,
    ProxmoxNodeVMNetIface,
    ProxmoxNodeVMStatus,
    ProxmoxGuestConfig,
    ProxmoxSdnVnet,
    ProxmoxSdnZone,
    ProxmoxNodeStorageStatus,
    ProxmoxGuestConfigUpdate,
    ProxmoxTaskError,
    ProxmoxTaskTimeoutError,
    ProxmoxTaskWaitOptions,
    ProxmoxFirewallIpSet,
    ProxmoxFirewallIpSetCreate,
    ProxmoxFirewallIpSetEntry,
    ProxmoxFirewallIpSetEntryInput,
    ProxmoxFirewallOptions,
    ProxmoxFirewallOptionsUpdate,
    ProxmoxFirewallRule,
    ProxmoxFirewallRuleInput,
    ProxmoxFirewallSecurityGroup,
    ProxmoxFirewallSecurityGroupCreate,
    ProxmoxFirewallSecurityGroupUpdate,
    ProxmoxSdnSubnet,
    ProxmoxSdnSubnetCreate,
    ProxmoxSdnSubnetUpdate,
    ProxmoxSdnVnetCreate,
    ProxmoxSdnVnetUpdate,
} from "./types";
import { logger } from "@/utils/logger";
import { proxmoxApiErrorsTotal } from "@/utils/metrics";

export function normaliseVmName(input: string, fallback = "vm"): string {
    const MAX_LABEL = 63;

    const cleanLabel = (raw: string): string => {
        const lowered = raw.toLowerCase();
        // Replace any run of non-alphanumerics with a single hyphen
        const hyphenated = lowered.replace(/[^a-z0-9]+/g, "-");
        // Strip leading/trailing hyphens and collapse duplicates (already handled by the regex above for runs)
        const trimmed = hyphenated.replace(/^-+|-+$/g, "");
        return trimmed.slice(0, MAX_LABEL).replace(/-+$/g, "");
    };

    const labels = input
        .split(".")
        .map(cleanLabel)
        .filter((l) => l.length > 0);

    if (labels.length === 0) return fallback;

    return labels.join(".");
}

function encodeForm(
    values: object,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(values)
            .filter((entry): entry is [string, string | number | boolean] =>
                entry[1] !== undefined,
            )
            .map(([key, value]) => [
                key,
                typeof value === "boolean" ? (value ? "1" : "0") : String(value),
            ]),
    );
}

export class ProxmoxClient {
    private readonly baseUrl: string;
    private readonly nodeName: string;
    private readonly authHeaders: Record<string, string>;
    private readonly httpAgent: Agent;
    private readonly maxGetRetries = 3;
    private readonly timeoutMs = 10000;

    constructor(config: ProxmoxClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, "") + "/api2/json";
        this.nodeName = config.nodeName;
        this.authHeaders = this.buildAuthHeaders(config.authToken);

        this.httpAgent = new Agent({
            connect: {
                rejectUnauthorized: config.rejectUnauthorized ?? true,
            },
        });
    }

    async close(): Promise<void> {
        await this.httpAgent.close();
    }

    private buildAuthHeaders(authToken: string): Record<string, string> {
        const token = authToken.trim();

        if (token.startsWith("PVEAPIToken=")) {
            return { Authorization: token };
        }

        if (token.startsWith("PVEAuthCookie=")) {
            return { Cookie: token };
        }

        if (token.includes("!") && token.includes("=")) {
            return { Authorization: `PVEAPIToken=${token}` };
        }

        return { Cookie: `PVEAuthCookie=${token}` };
    }

    private isRetryable(err: any): boolean {
        if (err instanceof ProxmoxApiError) {
            // Retry on auth issues (401, 403) as per user request
            return err.status === 401 || err.status === 403;
        }
        // Connectivity issues:
        // - TypeError: Network errors in fetch
        // - AbortError: Timeout/Cancellation
        return err instanceof TypeError || err.name === "AbortError";
    }

    private async request<T>(
        method: ProxmoxHTTPMethod,
        path: string,
        opts?: {
            query?: Record<string, string>;
            form?: Record<string, string>;
        },
    ): Promise<T> {
        const queryString = opts?.query
            ? `?${new URLSearchParams(opts.query).toString()}`
            : "";
        const url = `${this.baseUrl}${path}${queryString}`;

        const body = opts?.form
            ? new URLSearchParams(opts.form).toString()
            : undefined;
        const headers: Record<string, string> = {
            ...this.authHeaders,
            Accept: "application/json",
        };
        if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

        const attempts = method === "GET" ? this.maxGetRetries + 1 : 1;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(
                () => controller.abort(),
                this.timeoutMs,
            );

            try {
                const res = await fetch(url, {
                    method,
                    headers,
                    body,
                    signal: controller.signal,
                    dispatcher: this.httpAgent,
                });

                const text = await res.text();
                const parsed = text ? JSON.parse(text) : null;

                if (!res.ok) {
                    throw new ProxmoxApiError(
                        `Proxmox request failed: ${method} ${path}`,
                        res.status,
                        path,
                        parsed,
                    );
                }

                const envelope = parsed as ProxmoxApiResponse<T>;
                return envelope.data;
            } catch (err) {
                const lastAttempt = attempt === attempts;
                if (lastAttempt || !this.isRetryable(err)) {
                    // Normalise numeric ids out of the path so label cardinality stays bounded.
                    const opPath = path.replace(/\/\d+/g, "/:id");
                    proxmoxApiErrorsTotal.inc({ op: `${method} ${opPath}` });
                    throw err;
                }

                logger.warn(
                    { err, attempt, method, path },
                    "retrying proxmox GET",
                );
                await new Promise((r) => setTimeout(r, 300 * attempt));
            } finally {
                clearTimeout(timeout);
            }
        }

        throw new Error("unreachable");
    }

    async getVms(): Promise<ProxmoxNodeVM[]> {
        const resp = await this.request<Record<string, any>[]>(
            "GET",
            `/nodes/${this.nodeName}/qemu`,
        );

        // Replace - in keys with _ to match ProxmoxNodeVM interface
        return resp.map((vm) => {
            const transformed: Record<string, unknown> = {};
            for (const key in vm) {
                const newKey = key.replace(/-/g, "_");
                transformed[newKey] = vm[key as keyof ProxmoxNodeVM];
            }
            return transformed as unknown as ProxmoxNodeVM;
        });
    }

    async getVm(vmid: string): Promise<ProxmoxNodeVMStatus> {
        const resp = await this.request<Record<string, any>>(
            "GET",
            `/nodes/${this.nodeName}/qemu/${vmid}/status/current`,
        );

        // Replace - in keys with _ to match ProxmoxNodeVMStatus interface
        const transformed: Record<string, unknown> = {};
        for (const key in resp) {
            const newKey = key.replace(/-/g, "_");
            transformed[newKey] = resp[key as keyof ProxmoxNodeVMStatus];
        }
        return transformed as unknown as ProxmoxNodeVMStatus;
    }

    async getNodeNetworks(): Promise<ProxmoxNodeNetwork[]> {
        return this.request<ProxmoxNodeNetwork[]>(
            "GET",
            `/nodes/${this.nodeName}/network`,
        );
    }

    async getSdnZones(): Promise<ProxmoxSdnZone[]> {
        return this.request<ProxmoxSdnZone[]>("GET", "/cluster/sdn/zones");
    }

    async getSdnVnets(): Promise<ProxmoxSdnVnet[]> {
        return this.request<ProxmoxSdnVnet[]>("GET", "/cluster/sdn/vnets");
    }

    async getSdnVnet(vnet: string): Promise<ProxmoxSdnVnet> {
        return this.request<ProxmoxSdnVnet>(
            "GET",
            `/cluster/sdn/vnets/${encodeURIComponent(vnet)}`,
        );
    }

    async createSdnVnet(input: ProxmoxSdnVnetCreate): Promise<void> {
        await this.request<null>("POST", "/cluster/sdn/vnets", {
            form: encodeForm(input),
        });
    }

    async updateSdnVnet(vnet: string, input: ProxmoxSdnVnetUpdate): Promise<void> {
        await this.request<null>(
            "PUT",
            `/cluster/sdn/vnets/${encodeURIComponent(vnet)}`,
            { form: encodeForm(input) },
        );
    }

    async deleteSdnVnet(vnet: string): Promise<void> {
        await this.request<null>(
            "DELETE",
            `/cluster/sdn/vnets/${encodeURIComponent(vnet)}`,
        );
    }

    async getSdnSubnets(vnet: string): Promise<ProxmoxSdnSubnet[]> {
        return this.request<ProxmoxSdnSubnet[]>(
            "GET",
            `/cluster/sdn/vnets/${encodeURIComponent(vnet)}/subnets`,
        );
    }

    async getSdnSubnet(vnet: string, subnet: string): Promise<ProxmoxSdnSubnet> {
        return this.request<ProxmoxSdnSubnet>(
            "GET",
            `/cluster/sdn/vnets/${encodeURIComponent(vnet)}/subnets/${encodeURIComponent(subnet)}`,
        );
    }

    async createSdnSubnet(vnet: string, input: ProxmoxSdnSubnetCreate): Promise<void> {
        await this.request<null>(
            "POST",
            `/cluster/sdn/vnets/${encodeURIComponent(vnet)}/subnets`,
            { form: encodeForm(input) },
        );
    }

    async updateSdnSubnet(
        vnet: string,
        subnet: string,
        input: ProxmoxSdnSubnetUpdate,
    ): Promise<void> {
        await this.request<null>(
            "PUT",
            `/cluster/sdn/vnets/${encodeURIComponent(vnet)}/subnets/${encodeURIComponent(subnet)}`,
            { form: encodeForm(input) },
        );
    }

    async deleteSdnSubnet(vnet: string, subnet: string): Promise<void> {
        await this.request<null>(
            "DELETE",
            `/cluster/sdn/vnets/${encodeURIComponent(vnet)}/subnets/${encodeURIComponent(subnet)}`,
        );
    }

    async applySdnConfiguration(): Promise<string | null> {
        return this.request<string | null>("PUT", "/cluster/sdn");
    }

    async getFirewallSecurityGroups(): Promise<ProxmoxFirewallSecurityGroup[]> {
        return this.request<ProxmoxFirewallSecurityGroup[]>(
            "GET",
            "/cluster/firewall/groups",
        );
    }

    async createFirewallSecurityGroup(
        input: ProxmoxFirewallSecurityGroupCreate,
    ): Promise<void> {
        await this.request<null>("POST", "/cluster/firewall/groups", {
            form: encodeForm(input),
        });
    }

    async updateFirewallSecurityGroup(
        group: string,
        input: ProxmoxFirewallSecurityGroupUpdate,
    ): Promise<void> {
        await this.request<null>(
            "PUT",
            `/cluster/firewall/groups/${encodeURIComponent(group)}`,
            { form: encodeForm(input) },
        );
    }

    async deleteFirewallSecurityGroup(group: string, digest?: string): Promise<void> {
        await this.request<null>(
            "DELETE",
            `/cluster/firewall/groups/${encodeURIComponent(group)}`,
            { form: encodeForm({ digest }) },
        );
    }

    async getFirewallSecurityGroupRules(group: string): Promise<ProxmoxFirewallRule[]> {
        return this.request<ProxmoxFirewallRule[]>(
            "GET",
            `/cluster/firewall/groups/${encodeURIComponent(group)}`,
        );
    }

    async createFirewallSecurityGroupRule(
        group: string,
        input: ProxmoxFirewallRuleInput,
    ): Promise<void> {
        await this.request<null>(
            "POST",
            `/cluster/firewall/groups/${encodeURIComponent(group)}`,
            { form: encodeForm(input) },
        );
    }

    async updateFirewallSecurityGroupRule(
        group: string,
        position: number,
        input: ProxmoxFirewallRuleInput,
    ): Promise<void> {
        await this.request<null>(
            "PUT",
            `/cluster/firewall/groups/${encodeURIComponent(group)}/${position}`,
            { form: encodeForm(input) },
        );
    }

    async deleteFirewallSecurityGroupRule(
        group: string,
        position: number,
        digest?: string,
    ): Promise<void> {
        await this.request<null>(
            "DELETE",
            `/cluster/firewall/groups/${encodeURIComponent(group)}/${position}`,
            { form: encodeForm({ digest }) },
        );
    }

    async getFirewallIpSets(): Promise<ProxmoxFirewallIpSet[]> {
        return this.request<ProxmoxFirewallIpSet[]>("GET", "/cluster/firewall/ipset");
    }

    async createFirewallIpSet(input: ProxmoxFirewallIpSetCreate): Promise<void> {
        await this.request<null>("POST", "/cluster/firewall/ipset", {
            form: encodeForm(input),
        });
    }

    async updateFirewallIpSet(
        name: string,
        input: Omit<ProxmoxFirewallIpSetCreate, "name">,
    ): Promise<void> {
        await this.request<null>(
            "PUT",
            `/cluster/firewall/ipset/${encodeURIComponent(name)}`,
            { form: encodeForm(input) },
        );
    }

    async deleteFirewallIpSet(name: string, digest?: string): Promise<void> {
        await this.request<null>(
            "DELETE",
            `/cluster/firewall/ipset/${encodeURIComponent(name)}`,
            { form: encodeForm({ digest }) },
        );
    }

    async getFirewallIpSetEntries(name: string): Promise<ProxmoxFirewallIpSetEntry[]> {
        return this.request<ProxmoxFirewallIpSetEntry[]>(
            "GET",
            `/cluster/firewall/ipset/${encodeURIComponent(name)}`,
        );
    }

    async createFirewallIpSetEntry(
        name: string,
        input: ProxmoxFirewallIpSetEntryInput,
    ): Promise<void> {
        await this.request<null>(
            "POST",
            `/cluster/firewall/ipset/${encodeURIComponent(name)}`,
            { form: encodeForm(input) },
        );
    }

    async updateFirewallIpSetEntry(
        name: string,
        cidr: string,
        input: ProxmoxFirewallIpSetEntryInput,
    ): Promise<void> {
        await this.request<null>(
            "PUT",
            `/cluster/firewall/ipset/${encodeURIComponent(name)}/${encodeURIComponent(cidr)}`,
            { form: encodeForm(input) },
        );
    }

    async deleteFirewallIpSetEntry(
        name: string,
        cidr: string,
        digest?: string,
    ): Promise<void> {
        await this.request<null>(
            "DELETE",
            `/cluster/firewall/ipset/${encodeURIComponent(name)}/${encodeURIComponent(cidr)}`,
            { form: encodeForm({ digest }) },
        );
    }

    async getVmFirewallRules(vmid: string): Promise<ProxmoxFirewallRule[]> {
        return this.request<ProxmoxFirewallRule[]>(
            "GET",
            `/nodes/${encodeURIComponent(this.nodeName)}/qemu/${encodeURIComponent(vmid)}/firewall/rules`,
        );
    }

    async createVmFirewallRule(
        vmid: string,
        input: ProxmoxFirewallRuleInput,
    ): Promise<void> {
        await this.request<null>(
            "POST",
            `/nodes/${encodeURIComponent(this.nodeName)}/qemu/${encodeURIComponent(vmid)}/firewall/rules`,
            { form: encodeForm(input) },
        );
    }

    async updateVmFirewallRule(
        vmid: string,
        position: number,
        input: ProxmoxFirewallRuleInput,
    ): Promise<void> {
        await this.request<null>(
            "PUT",
            `/nodes/${encodeURIComponent(this.nodeName)}/qemu/${encodeURIComponent(vmid)}/firewall/rules/${position}`,
            { form: encodeForm(input) },
        );
    }

    async deleteVmFirewallRule(
        vmid: string,
        position: number,
        digest?: string,
    ): Promise<void> {
        await this.request<null>(
            "DELETE",
            `/nodes/${encodeURIComponent(this.nodeName)}/qemu/${encodeURIComponent(vmid)}/firewall/rules/${position}`,
            { form: encodeForm({ digest }) },
        );
    }

    async getVmFirewallOptions(vmid: string): Promise<ProxmoxFirewallOptions> {
        return this.request<ProxmoxFirewallOptions>(
            "GET",
            `/nodes/${encodeURIComponent(this.nodeName)}/qemu/${encodeURIComponent(vmid)}/firewall/options`,
        );
    }

    async updateVmFirewallOptions(
        vmid: string,
        input: ProxmoxFirewallOptionsUpdate,
    ): Promise<void> {
        await this.request<null>(
            "PUT",
            `/nodes/${encodeURIComponent(this.nodeName)}/qemu/${encodeURIComponent(vmid)}/firewall/options`,
            { form: encodeForm(input) },
        );
    }

    async getVmConfig(vmid: string): Promise<ProxmoxGuestConfig> {
        return this.request<ProxmoxGuestConfig>(
            "GET",
            `/nodes/${this.nodeName}/qemu/${vmid}/config`,
        );
    }

    async getContainerConfig(vmid: string): Promise<ProxmoxGuestConfig> {
        return this.request<ProxmoxGuestConfig>(
            "GET",
            `/nodes/${this.nodeName}/lxc/${vmid}/config`,
        );
    }

    async getNodeStorageStatus(storage: string): Promise<ProxmoxNodeStorageStatus> {
        return this.request<ProxmoxNodeStorageStatus>(
            "GET",
            `/nodes/${this.nodeName}/storage/${encodeURIComponent(storage)}/status`,
        );
    }

    async getVmNetIfaces(
        vmid: string,
    ): Promise<Record<string, ProxmoxNodeVMNetIface>> {
        const resp = await this.request<{ result: ProxmoxNodeVMNetIface[] }>(
            "GET",
            `/nodes/${this.nodeName}/qemu/${vmid}/agent/network-get-interfaces`,
        );

        const ifaces: Record<string, ProxmoxNodeVMNetIface> = {};
        if (Array.isArray(resp.result)) {
            for (const iface of resp.result) {
                if (iface.name) {
                    ifaces[iface.name] = iface;
                }
            }
        }
        return ifaces;
    }

    async pollTask(upid: string): Promise<ProxmoxNodeTaskStatus> {
        return this.request<ProxmoxNodeTaskStatus>(
            "GET",
            `/nodes/${encodeURIComponent(this.nodeName)}/tasks/${encodeURIComponent(upid)}/status`,
        );
    }

    async waitForTask(
        upid: string,
        options: ProxmoxTaskWaitOptions = {},
    ): Promise<ProxmoxNodeTaskStatus> {
        const timeoutMs = options.timeoutMs ?? 120_000;
        const pollIntervalMs = options.pollIntervalMs ?? 2_000;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const task = await this.pollTask(upid);
            if (task.status === "stopped") {
                if (task.exitstatus === "OK") return task;
                throw new ProxmoxTaskError(task);
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        throw new ProxmoxTaskTimeoutError(upid, timeoutMs);
    }

    async waitForTaskCompletion(upid: string): Promise<boolean> {
        try {
            await this.waitForTask(upid);
            return true;
        } catch (err) {
            logger.error(
                { err, upid },
                "Failed while waiting for Proxmox task completion",
            );
            return false;
        }
    }

    async cloneVM(
        from_id: string,
        new_id: string,
        name: string,
        full: number = 0,
    ): Promise<string> {
        const resp = await this.request<any>(
            "POST",
            `/nodes/${this.nodeName}/qemu/${from_id}/clone`,
            {
                form: {
                    newid: new_id,
                    name: normaliseVmName(name),
                    full: full.toString(),
                },
            },
        );

        return resp as string;
    }

    async updateVmConfig(vmid: string, data: ProxmoxGuestConfigUpdate): Promise<void> {
        await this.request<null>(
            "PUT",
            `/nodes/${encodeURIComponent(this.nodeName)}/qemu/${encodeURIComponent(vmid)}/config`,
            {
                form: encodeForm(data),
            },
        );
    }

    async updateContainerConfig(
        vmid: string,
        data: ProxmoxGuestConfigUpdate,
    ): Promise<void> {
        await this.request<null>(
            "PUT",
            `/nodes/${encodeURIComponent(this.nodeName)}/lxc/${encodeURIComponent(vmid)}/config`,
            { form: encodeForm(data) },
        );
    }

    async configVM(vmid: string, data: Record<string, string>): Promise<void> {
        await this.updateVmConfig(vmid, data);
    }

    async startVM(vmid: string): Promise<string> {
        return this.request<string>(
            "POST",
            `/nodes/${this.nodeName}/qemu/${vmid}/status/start`,
        );
    }

    async stopVM(vmid: string): Promise<string> {
        return this.request<string>(
            "POST",
            `/nodes/${this.nodeName}/qemu/${vmid}/status/stop`,
        );
    }

    async rebootVM(vmid: string): Promise<string> {
        return this.request<string>(
            "POST",
            `/nodes/${this.nodeName}/qemu/${vmid}/status/reboot`,
        );
    }

    async deleteVM(vmid: string): Promise<string> {
        // stop=1 forcibly powers off before deletion so it works even on running VMs
        return this.request<string>(
            "DELETE",
            `/nodes/${this.nodeName}/qemu/${vmid}`,
            { query: { purge: "1", "destroy-unreferenced-disks": "1" } },
        );
    }

    async getClusterResources(
        type: "vm" | "storage" | "node" | "sdn",
    ): Promise<any> {
        return this.request<any>("GET", `/cluster/resources?type=${type}`);
    }

    async getNextAvailableId(minId: number = 10000): Promise<string> {
        const resources: any[] = await this.getClusterResources("vm");
        const used = new Set<number>(resources.map((r) => r.vmid));

        let candidate = minId;
        while (used.has(candidate)) {
            candidate++;
        }
        return String(candidate);
    }
}
