import { Agent, fetch } from "undici";
import { logger } from "@/utils/logger";
import { metadata } from "@/utils/metadata";
import {
    GuacamoleApiError,
    GuacamoleClientConfig,
    GuacamoleConnection,
    GuacamoleConnectionParameters,
    GuacamoleConnectionsResponse,
    GuacamoleConnectionSummary,
    GuacamoleHTTPMethod,
    GuacamolePermsResponse,
    GuacamoleUser,
    GuacamoleUsersResponse,
} from "./types";

export class GuacamoleClient {
    private readonly baseUrl: string;
    private readonly publicUrl: string | null;
    private readonly username: string;
    private readonly password: string;
    private readonly maxGetRetries = 3;
    private readonly httpAgent: Agent;
    private settingsCache: {
        parentIdentifier: string;
        timeoutMs: number;
    } | null = null;

    private authToken: string | null = null;
    private dataSource: string | null = "postgresql";

    private connectionCache: Record<string, GuacamoleConnectionSummary> = {};
    private connectionCacheFetching: Promise<GuacamoleConnectionsResponse> | null =
        null;
    private connectionCacheOutdated = true;

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

    private async getSettings(): Promise<{
        parentIdentifier: string;
        timeoutMs: number;
    }> {
        if (this.settingsCache) return this.settingsCache;
        const [parentIdentifier, timeoutMs] = await Promise.all([
            metadata.get<string>("settings.guacamole.parentIdentifier"),
            metadata.get<number>("settings.guacamole.requestTimeoutMs"),
        ]);
        this.settingsCache = {
            parentIdentifier: parentIdentifier ?? "1",
            timeoutMs: timeoutMs ?? 10_000,
        };
        return this.settingsCache;
    }

    invalidateConnectionCache() {
        this.connectionCacheOutdated = true;
    }

    async getConnectionCache(
        refetch: boolean = false,
    ): Promise<Record<string, GuacamoleConnectionSummary>> {
        if (refetch || this.connectionCacheOutdated) {
            this.connectionCacheFetching ??= this.listConnections().finally(
                () => {
                    this.connectionCacheFetching = null;
                },
            );
            await this.connectionCacheFetching;
        }
        return this.connectionCache;
    }

    async getToken(
        username: string,
        password: string,
    ): Promise<{ token: string; dataSource: string }> {
        const url = `${this.baseUrl}/api/tokens`;
        const headers: Record<string, string> = {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        };

        const body = new URLSearchParams({
            username: username,
            password: password,
        } as Record<string, string>).toString();

        const { timeoutMs } = await this.getSettings();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

            return {
                token: parsed.authToken,
                dataSource: parsed.dataSource,
            };
        } catch (err) {
            logger.error(err, "Failed to login to Guacamole");
            throw new GuacamoleApiError(
                "Failed to log in",
                500,
                "/api/tokens",
                err,
            );
        } finally {
            clearTimeout(timeout);
        }
    }

    async getSessionUrl(userId: string, connectionId: string): Promise<string> {
        const userAuth = await this.getToken(userId, userId);
        const urlB64Data = `${connectionId}\0c\0${this.dataSource}`;
        const encodedUrlData = Buffer.from(urlB64Data).toString("base64url");

        return `${this.publicUrl}/#/client/${encodedUrlData}?token=${userAuth.token}`;
    }

    private async updateToken() {
        const data = await this.getToken(this.username, this.password);

        this.authToken = data.token;
        this.dataSource = data.dataSource;
    }

    private async request<T>(
        method: GuacamoleHTTPMethod,
        path: string,
        opts?: {
            query?: Record<string, string>;
            body?: unknown;
        },
    ): Promise<T> {
        if (this.authToken == null || this.dataSource == null) {
            logger.debug("null Guacamole Authtoken||dataSource, relog");
            await this.updateToken();
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

        const { timeoutMs } = await this.getSettings();
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const res = await fetch(url, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal,
                    dispatcher: this.httpAgent,
                });

                const text = await res.text();
                let parsed: any = null;

                if (text) {
                    try {
                        parsed = JSON.parse(text);
                    } catch {
                        parsed = { error: text }; // preserve plain-text errors
                    }
                }

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
                const isClientError =
                    err instanceof GuacamoleApiError &&
                    err.status >= 400 &&
                    err.status < 500;
                if (lastAttempt || isClientError) throw err;

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

    async getUser(username: string): Promise<GuacamoleUser | null> {
        try {
            return await this.request<GuacamoleUser>(
                "GET",
                `/api/session/data/${this.dataSource}/users/${username}`,
            );
        } catch (err) {
            if (err instanceof GuacamoleApiError && err.status === 404) {
                return null;
            }
            throw err;
        }
    }

    async createUser(
        username: string,
        password: string,
    ): Promise<GuacamoleUser> {
        const payload: Record<string, unknown> = {
            username: username,
            password: password,
            attributes: {
                expired: "",
                "access-window-start": "",
                "access-window-end": "",
                "valid-from": "",
                "valid-until": "",
                timezone: null,
            },
        };

        return this.request<GuacamoleUser>(
            "POST",
            `/api/session/data/${this.dataSource}/users`,
            {
                body: payload,
            },
        );
    }

    async getUserPerms(username: string): Promise<GuacamolePermsResponse> {
        return this.request<GuacamolePermsResponse>(
            "GET",
            `/api/session/data/${this.dataSource}/users/${username}/permissions`,
        );
    }

    async createConnection(
        machineIp: string,
        machineOwnerId: string,
        machineId: string,
    ): Promise<GuacamoleConnection> {
        const { parentIdentifier } = await this.getSettings();
        const payload: Record<string, unknown> = {
            parentIdentifier: parentIdentifier,
            name: machineId,
            protocol: "rdp",
            parameters: {
                port: "3389",
                "read-only": "",
                "swap-red-blue": "",
                cursor: "",
                "color-depth": "",
                "clipboard-encoding": "",
                "disable-copy": "",
                "disable-paste": "",
                "dest-port": "",
                "recording-exclude-output": "",
                "recording-exclude-mouse": "",
                "recording-include-keys": "",
                "create-recording-path": "",
                "enable-sftp": "",
                "sftp-port": "",
                "sftp-server-alive-interval": "",
                "enable-audio": "",
                security: "any",
                "disable-auth": "",
                "ignore-cert": "true",
                "gateway-port": "",
                "server-layout": "",
                timezone: "",
                console: "",
                width: "",
                height: "",
                dpi: "",
                "resize-method": "display-update",
                "console-audio": "",
                "disable-audio": "",
                "enable-audio-input": "",
                "enable-printing": "",
                "enable-drive": "",
                "create-drive-path": "",
                "enable-wallpaper": "",
                "enable-theming": "",
                "enable-font-smoothing": "",
                "enable-full-window-drag": "",
                "enable-desktop-composition": "",
                "enable-menu-animations": "",
                "disable-bitmap-caching": "",
                "disable-offscreen-caching": "",
                "disable-glyph-caching": "",
                "preconnection-id": "",
                hostname: machineIp,
                username: "user",
                password: machineOwnerId,
                domain: "",
                "gateway-hostname": "",
                "gateway-username": "",
                "gateway-password": "",
                "gateway-domain": "",
                "initial-program": "",
                "client-name": "",
                "printer-name": "",
                "drive-name": "",
                "drive-path": "",
                "static-channels": "",
                "remote-app": "",
                "remote-app-dir": "",
                "remote-app-args": "",
                "preconnection-blob": "",
                "load-balance-info": "",
                "recording-path": "",
                "recording-name": "",
                "sftp-hostname": "",
                "sftp-host-key": "",
                "sftp-username": "",
                "sftp-password": "",
                "sftp-private-key": "",
                "sftp-passphrase": "",
                "sftp-root-directory": "",
                "sftp-directory": "",
            },
            attributes: {
                "max-connections": "",
                "max-connections-per-user": "1",
                weight: "",
                "failover-only": "",
                "guacd-port": "",
                "guacd-encryption": "",
                "guacd-hostname": "",
            },
        };

        this.connectionCacheOutdated = true;

        return this.request<GuacamoleConnection>(
            "POST",
            `/api/session/data/${this.dataSource}/connections`,
            {
                body: payload,
            },
        );
    }

    async updateConnectionIp(
        machineId: string,
        machineOwnerId: string,
        newMachineIp: string,
        guacIdentifier: string,
    ): Promise<GuacamoleConnection> {
        const { parentIdentifier } = await this.getSettings();
        const payload: Record<string, unknown> = {
            parentIdentifier: parentIdentifier,
            identifier: guacIdentifier,
            name: machineId,
            protocol: "rdp",
            parameters: {
                port: "3389",
                "read-only": "",
                "swap-red-blue": "",
                cursor: "",
                "color-depth": "",
                "clipboard-encoding": "",
                "disable-copy": "",
                "disable-paste": "",
                "dest-port": "",
                "recording-exclude-output": "",
                "recording-exclude-mouse": "",
                "recording-include-keys": "",
                "create-recording-path": "",
                "enable-sftp": "",
                "sftp-port": "",
                "sftp-server-alive-interval": "",
                "enable-audio": "",
                security: "any",
                "disable-auth": "",
                "ignore-cert": "true",
                "gateway-port": "",
                "server-layout": "",
                timezone: "",
                console: "",
                width: "",
                height: "",
                dpi: "",
                "resize-method": "display-update",
                "console-audio": "",
                "disable-audio": "",
                "enable-audio-input": "",
                "enable-printing": "",
                "enable-drive": "",
                "create-drive-path": "",
                "enable-wallpaper": "",
                "enable-theming": "",
                "enable-font-smoothing": "",
                "enable-full-window-drag": "",
                "enable-desktop-composition": "",
                "enable-menu-animations": "",
                "disable-bitmap-caching": "",
                "disable-offscreen-caching": "",
                "disable-glyph-caching": "",
                "preconnection-id": "",
                hostname: newMachineIp,
                username: "user",
                password: machineOwnerId,
                domain: "",
                "gateway-hostname": "",
                "gateway-username": "",
                "gateway-password": "",
                "gateway-domain": "",
                "initial-program": "",
                "client-name": "",
                "printer-name": "",
                "drive-name": "",
                "drive-path": "",
                "static-channels": "",
                "remote-app": "",
                "remote-app-dir": "",
                "remote-app-args": "",
                "preconnection-blob": "",
                "load-balance-info": "",
                "recording-path": "",
                "recording-name": "",
                "sftp-hostname": "",
                "sftp-host-key": "",
                "sftp-username": "",
                "sftp-password": "",
                "sftp-private-key": "",
                "sftp-passphrase": "",
                "sftp-root-directory": "",
                "sftp-directory": "",
            },
            attributes: {
                "max-connections": "",
                "max-connections-per-user": "1",
                weight: "",
                "failover-only": "",
                "guacd-port": "",
                "guacd-encryption": "",
                "guacd-hostname": "",
            },
        };

        this.connectionCacheOutdated = true;

        return this.request<GuacamoleConnection>(
            "PUT",
            `/api/session/data/${this.dataSource}/connections/${guacIdentifier}`,
            {
                body: payload,
            },
        );
    }

    async listConnections(): Promise<GuacamoleConnectionsResponse> {
        const resp = await this.request<GuacamoleConnectionsResponse>(
            "GET",
            `/api/session/data/${this.dataSource}/connections`,
        );

        // Update connectionCache
        for (const key of Object.keys(this.connectionCache)) {
            delete this.connectionCache[key];
        }
        for (const conn of Object.values(resp)) {
            this.connectionCache[conn.name] = conn;
        }
        this.connectionCacheOutdated = false;

        return resp;
    }

    async giveUserAccessToMachine(username: string, machineId: string) {
        return this.request(
            "PATCH",
            `/api/session/data/${this.dataSource}/users/${username}/permissions`,
            {
                body: [
                    {
                        op: "add",
                        path: `/connectionPermissions/${machineId}`,
                        value: "READ",
                    },
                ],
            },
        );
    }

    async fetchConnectionParams(
        connectionName: string,
    ): Promise<GuacamoleConnectionParameters> {
        return this.request<GuacamoleConnectionParameters>(
            "GET",
            `/api/session/data/${this.dataSource}/connections/${connectionName}/parameters`,
        );
    }

    async getConnectionSummary(
        connectionName: string,
    ): Promise<GuacamoleConnectionSummary | null> {
        const cData = await this.getConnectionCache();
        return cData[connectionName] ? cData[connectionName] : null;
    }

    async deleteConnection(identifier: string): Promise<void> {
        await this.request<void>(
            "DELETE",
            `/api/session/data/${this.dataSource}/connections/${identifier}`,
        );
        this.connectionCacheOutdated = true;
    }
}
