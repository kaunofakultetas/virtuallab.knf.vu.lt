import { Agent, fetch } from "undici";
import { logger } from "@/utils/logger";
import {
    GuacamoleApiError,
    GuacamoleClientConfig,
    GuacamoleHTTPMethod,
    GuacamoleUsersResponse,
} from "./types";

export class GuacamoleClient {
    private readonly baseUrl: string;
    private readonly publicUrl: string | null;
    private readonly username: string;
    private readonly password: string;
    private readonly maxGetRetries = 3;
    private readonly timeoutMs = 10000;
    private readonly httpAgent: Agent;

    private authToken: string | null = null;
    private dataSource: string | null = "postgresql";

    constructor(config: GuacamoleClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.publicUrl = config.publicUrl
            ? config.publicUrl.replace(/\/+$/, "")
            : null;

        this.username = config.username;
        this.password = config.password;

        this.httpAgent = new Agent({
            connect: {
                rejectUnauthorized: config.rejectUnauthorized ?? true,
            },
        });
    }

    private async getToken() {
        const url = `${this.baseUrl}/api/tokens`;
        const headers: Record<string, string> = {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        };

        const body = new URLSearchParams({
            username: this.username,
            password: this.password,
        } as Record<string, string>).toString();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const res = await fetch(url, {
                method: "POST",
                headers,
                body,
                signal: controller.signal,
                dispatcher: this.httpAgent,
            });

            const text = await res.text();
            const parsed = text ? JSON.parse(text) : null;

            this.authToken = parsed.authToken;
            this.dataSource = parsed.dataSource;
        } catch (err) {
            logger.error(err, "Failed to login to Guacamole");
        } finally {
            clearTimeout(timeout);
        }
    }

    private async request<T>(
        method: GuacamoleHTTPMethod,
        path: string,
        opts?: {
            query?: Record<string, string>;
            body?: Record<string, string>;
        },
    ): Promise<T> {
        if (this.authToken == null || this.dataSource == null) {
            logger.debug("null Guacamole Authtoken||dataSource, relog");
            await this.getToken();
        }

        if (!opts) opts = {};
        if (!opts.query) opts.query = {};
        opts.query["token"] = this.authToken!;

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
            const timeout = setTimeout(
                () => controller.abort(),
                this.timeoutMs,
            );

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

    async getUsers(): Promise<GuacamoleUsersResponse> {
        return this.request<GuacamoleUsersResponse>(
            "GET",
            `/api/session/data/${this.dataSource}/users`,
        );
    }
}
