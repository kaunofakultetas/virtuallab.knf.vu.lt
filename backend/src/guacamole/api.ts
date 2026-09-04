// -----------------------------------------------------------
//  [*] Guacamole — the HTTP API client
//
//  One class wrapping Guacamole's REST API. Auth is lazy:
//  the admin token is fetched on first use and refreshed
//  once per request on a 403, so an expired session heals
//  itself mid-flight. Connections are cached BY NAME (names
//  are our instance IDs) and the cache is invalidated by
//  every mutating call, refreshed by listConnections().
//
//  The RDP/SSH create and update methods carry Guacamole's
//  full parameter sheets with mostly empty strings — that is
//  what the Guacamole API expects for "unset"; only
//  hostname, credentials, port and the one-session-per-user
//  attribute actually vary.
//
//  Used by:
//    - guacamole/index.ts — the app-wide singleton
//    - instances.controller.ts / instances.route.ts — user,
//      connection and session-URL management
//    - users.controller.ts, metrics-poller.ts
// -----------------------------------------------------------

import { Agent, fetch } from "undici";
import { logger } from "@/utils/logger";
import { metadata } from "@/utils/metadata";
import { guacamoleApiErrorsTotal } from "@/utils/metrics";
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

    // Keyed by connection NAME (our instance ID), not Guacamole's identifier.
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

    // parentIdentifier and the request timeout come from the metadata store;
    // cached for the client's lifetime, so changing them needs a restart.
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


    // -------------------------------------------------------
    // Connection cache
    // -------------------------------------------------------

    invalidateConnectionCache() {
        this.connectionCacheOutdated = true;
    }

    // The fetch is deduplicated: concurrent callers share one in-flight
    // listConnections() instead of stampeding the API.
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


    // -------------------------------------------------------
    // Auth and session URLs
    // -------------------------------------------------------

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

    // Logs in AS THE STUDENT and builds the deep link straight into the
    // connection's client view. The password is passed in rather than derived:
    // it used to be the user's own vu_id, which made every Guacamole account
    // guessable from a student number.
    //
    // The `?token=` sits after the `#`, so it is part of the fragment and is
    // never sent to a server — do not move it into the query string.
    async getSessionUrl(
        userId: string,
        guacPassword: string,
        connectionId: string,
    ): Promise<string> {
        const userAuth = await this.getToken(userId, guacPassword);

        // getToken does not check res.ok: a rejected login yields
        // `{token: undefined}` rather than throwing, which would otherwise
        // produce a working-looking URL carrying the literal "undefined".
        if (!userAuth.token) {
            throw new GuacamoleApiError(
                `Guacamole rejected the credentials for user ${userId}`,
                401,
                "/api/tokens",
            );
        }

        const urlB64Data = `${connectionId}\0c\0${this.dataSource}`;
        const encodedUrlData = Buffer.from(urlB64Data).toString("base64url");

        return `${this.publicUrl}/#/client/${encodedUrlData}?token=${userAuth.token}`;
    }

    private async updateToken() {
        const data = await this.getToken(this.username, this.password);

        this.authToken = data.token;
        this.dataSource = data.dataSource;
    }


    // -------------------------------------------------------
    // Transport — every method below funnels through this
    // -------------------------------------------------------

    // GETs retry with linear backoff; one 403 triggers a re-login without
    // consuming an attempt. 404s stay out of the error counter because this
    // codebase regularly uses them as a normal "missing" signal.
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

        const body = opts?.body || undefined;

        const headers: Record<string, string> = {
            Accept: "application/json",
        };
        if (body) headers["Content-Type"] = "application/json";

        const attempts = method === "GET" ? this.maxGetRetries + 1 : 1;
        let tokenRefreshed = false;

        const { timeoutMs } = await this.getSettings();
        for (let attempt = 1; attempt <= attempts; attempt++) {
            // Re-read on every attempt, so a mid-loop re-login is picked up
            // automatically.
            //
            // Sent as a HEADER, not in the query string. GUACAMOLE_URL is plain
            // HTTP (http://exit:8080), so a token in the URL crossed the network
            // in cleartext on every single call and was written to Guacamole's
            // access log, where anyone who could read it held Guacamole
            // administrator. `Guacamole-Token` has been supported since 1.4;
            // this deployment runs 1.6.
            headers["Guacamole-Token"] = this.authToken!;
            const queryEntries = Object.keys(opts.query).length > 0;
            const queryString = queryEntries
                ? `?${new URLSearchParams(opts.query).toString()}`
                : "";
            const url = `${this.baseUrl}${path}${queryString}`;

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
                if (
                    err instanceof GuacamoleApiError &&
                    err.status === 403 &&
                    !tokenRefreshed
                ) {
                    tokenRefreshed = true;
                    logger.warn(
                        { method, path },
                        "Guacamole token expired, re-authenticating",
                    );
                    await this.updateToken();
                    attempt--;
                    continue;
                }

                const lastAttempt = attempt === attempts;
                const isClientError =
                    err instanceof GuacamoleApiError &&
                    err.status >= 400 &&
                    err.status < 500;
                if (lastAttempt || isClientError) {
                    // 404 in this codebase is regularly used as a normal "missing" signal
                    // (e.g. getUser / deleteUser / getConnectionSummary) — don't count those.
                    const status =
                        err instanceof GuacamoleApiError ? err.status : 0;
                    if (status !== 404) {
                        const opPath = path
                            .replace(
                                /\/session\/data\/[^/]+/,
                                "/session/data/:ds",
                            )
                            .replace(
                                /\/(users|connections)\/[^/?]+/g,
                                "/$1/:id",
                            );
                        guacamoleApiErrorsTotal.inc({
                            op: `${method} ${opPath}`,
                        });
                    }
                    throw err;
                }

                logger.warn(
                    { err, attempt, method, path },
                    "retrying guacamole GET",
                );
                await new Promise((r) => setTimeout(r, 300 * attempt));
            } finally {
                clearTimeout(timeout);
            }
        }

        throw new Error("unreachable");
    }


    // -------------------------------------------------------
    // Users
    // -------------------------------------------------------

    async getUsers(): Promise<GuacamoleUsersResponse> {
        return this.request<GuacamoleUsersResponse>(
            "GET",
            `/api/session/data/${this.dataSource}/users`,
        );
    }

    // null on 404 — "no such user" is an answer, not an error.
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


    // -------------------------------------------------------
    // RDP connections
    // -------------------------------------------------------

    async createConnection(
        machineIp: string,
        machineOwnerId: string,
        machineId: string,
        options: { username?: string; password?: string } = {},
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
                username: options.username ?? "user",
                password: options.password ?? machineOwnerId,
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

    // Same sheet as createConnection, resent in full with the new hostname —
    // Guacamole's PUT replaces the whole parameter set, so a partial update
    // would blank everything else.
    async updateConnectionIp(
        machineId: string,
        machineOwnerId: string,
        newMachineIp: string,
        guacIdentifier: string,
        options: { username?: string; password?: string } = {},
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
                username: options.username ?? "user",
                password: options.password ?? machineOwnerId,
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


    // -------------------------------------------------------
    // Connection listing, permissions and lookups
    // -------------------------------------------------------

    async listConnections(): Promise<GuacamoleConnectionsResponse> {
        const resp = await this.request<GuacamoleConnectionsResponse>(
            "GET",
            `/api/session/data/${this.dataSource}/connections`,
        );

        // Rebuild the cache in place — clearing keys rather than swapping the
        // object keeps references handed out earlier valid.
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


    // -------------------------------------------------------
    // SSH connections — the leaner parameter sheet
    // -------------------------------------------------------

    async createSshConnection(
        machineIp: string,
        machineId: string,
        options: { port?: number; username?: string; password?: string } = {},
    ): Promise<GuacamoleConnection> {
        const { parentIdentifier } = await this.getSettings();
        const payload: Record<string, unknown> = {
            parentIdentifier: parentIdentifier,
            name: machineId,
            protocol: "ssh",
            parameters: {
                hostname: machineIp,
                port: String(options.port ?? 22),
                username: options.username ?? "user",
                password: options.password ?? "",
                "server-alive-interval": "",
                "backspace-key": "",
                "terminal-type": "",
                "color-scheme": "",
                "font-name": "",
                "font-size": "",
                scrollback: "",
                "read-only": "",
                "disable-copy": "",
                "disable-paste": "",
                "recording-path": "",
                "recording-name": "",
                "recording-exclude-output": "",
                "recording-exclude-mouse": "",
                "recording-include-keys": "",
                "create-recording-path": "",
                "private-key": "",
                passphrase: "",
                "sftp-root-directory": "",
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
            { body: payload },
        );
    }

    async updateSshConnection(
        machineId: string,
        newMachineIp: string,
        guacIdentifier: string,
        options: { port?: number; username?: string; password?: string } = {},
    ): Promise<GuacamoleConnection> {
        const { parentIdentifier } = await this.getSettings();
        const payload: Record<string, unknown> = {
            parentIdentifier: parentIdentifier,
            identifier: guacIdentifier,
            name: machineId,
            protocol: "ssh",
            parameters: {
                hostname: newMachineIp,
                port: String(options.port ?? 22),
                username: options.username ?? "user",
                password: options.password ?? "",
                "server-alive-interval": "",
                "backspace-key": "",
                "terminal-type": "",
                "color-scheme": "",
                "font-name": "",
                "font-size": "",
                scrollback: "",
                "read-only": "",
                "disable-copy": "",
                "disable-paste": "",
                "recording-path": "",
                "recording-name": "",
                "recording-exclude-output": "",
                "recording-exclude-mouse": "",
                "recording-include-keys": "",
                "create-recording-path": "",
                "private-key": "",
                passphrase: "",
                "sftp-root-directory": "",
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
            { body: payload },
        );
    }

    // Idempotent: deleting an already-absent user succeeds silently.
    async deleteUser(username: string): Promise<void> {
        try {
            await this.request<void>(
                "DELETE",
                `/api/session/data/${this.dataSource}/users/${username}`,
            );
        } catch (err) {
            if (err instanceof GuacamoleApiError && err.status === 404) {
                return;
            }
            throw err;
        }
    }
}
