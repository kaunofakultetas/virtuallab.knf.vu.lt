import { Agent, fetch } from "undici";
import { logger } from "@/utils/logger";
import {
  GuacamoleApiError,
  GuacamoleClientConfig,
  GuacamoleHTTPMethod,
} from "./types";

export class GuacamoleClient {
  private readonly baseUrl: string;
  private readonly maxGetRetries = 3;
  private readonly timeoutMs = 10000;
  private readonly httpAgent: Agent;

  private adminToken: string | null = null;

  constructor(config: GuacamoleClientConfig) {
    this.baseUrl = config.baseUrl;

    this.httpAgent = new Agent({
      connect: {
        rejectUnauthorized: config.rejectUnauthorized ?? true,
      },
    });
  }

  private async request<T>(
    method: GuacamoleHTTPMethod,
    path: string,
    opts?: {
      query?: Record<string, string>;
      body?: Record<string, string>;
    },
  ): Promise<T> {
    const queryString = opts?.query
      ? `?${new URLSearchParams(opts.query).toString()}`
      : "";
    const url = `${this.baseUrl}${path}${queryString}`;

    const body = opts?.body || undefined;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body) headers["Content-Type"] = "application/json";

    const attempts = method === "GET" ? this.maxGetRetries + 1 : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          dispatcher: this.httpAgent,
        });

        const text = await res.text();
        const parsed = text ? JSON.parse(text) : null;

        if (!res.ok) {
          throw new GuacamoleApiError(
            `Guacamole request failed: ${method} ${path}`,
            res.status,
            path,
            parsed,
          );
        }

        return parsed;
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
}
