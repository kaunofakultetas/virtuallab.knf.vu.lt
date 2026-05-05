import { Agent, fetch } from "undici";
import {
  ProxmoxApiError,
  ProxmoxApiResponse,
  ProxmoxClientConfig,
  ProxmoxHTTPMethod,
  ProxmoxNodeVM,
  ProxmoxNodeVMStatus,
} from "./types";
import { logger } from "@/utils/logger";

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
}
