import { Agent, fetch } from "undici";
import {
  ProxmoxApiError,
  ProxmoxApiResponse,
  ProxmoxClientConfig,
  ProxmoxHTTPMethod,
  ProxmoxNodeTaskStatus,
  ProxmoxNodeVM,
  ProxmoxNodeVMNetIface,
  ProxmoxNodeVMStatus,
} from "./types";
import { logger } from "@/utils/logger";

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

  private async request<T>(
    method: ProxmoxHTTPMethod,
    path: string,
    opts?: { query?: Record<string, string>; form?: Record<string, string> },
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
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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
        if (lastAttempt) throw err;

        logger.warn({ err, attempt, method, path }, "retrying proxmox GET");
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
    const resp = await this.request<any>(
      "GET",
      `/nodes/${this.nodeName}/tasks/${upid}/status`,
    );

    return resp as ProxmoxNodeTaskStatus;
  }

  async waitForTaskCompletion(upid: string): Promise<boolean> {
    const timeoutMs = 120_000;
    const pollIntervalMs = 2_000;
    const startedAt = Date.now();

    try {
      while (Date.now() - startedAt < timeoutMs) {
        const task = await this.pollTask(upid);

        if (task.status === "stopped") {
          if (task.exitstatus === "OK") {
            return true;
          }

          logger.error(
            { upid, status: task.status, exitstatus: task.exitstatus },
            "Proxmox task finished with non-OK exit status",
          );
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      logger.error({ upid, timeoutMs }, "Proxmox task polling timed out");
      return false;
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

  async configVM(vmid: string, data: Record<string, string>) {
    await this.request<null>(
      "PUT",
      `/nodes/${this.nodeName}/qemu/${vmid}/config`,
      {
        form: data,
      },
    );
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
}
