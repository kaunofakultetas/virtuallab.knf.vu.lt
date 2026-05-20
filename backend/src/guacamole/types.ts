export type GuacamoleHTTPMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GuacamoleClientConfig {
    baseUrl: string;
    publicUrl?: string;
    username: string;
    password: string;
    rejectUnauthorized?: boolean;
}

export class GuacamoleApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly path: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = "GuacamoleApiError";
    }
}

export interface GuacamoleUser {
    username: string;
    disabled: boolean;
    attributes: {
        "guac-email-address": string | null;
        "guac-organizational-role": string | null;
        "guac-full-name": string | null;
        expired: string | null;
        timezone: string | null;
        "access-window-start": string | null;
        "guac-organization": string | null;
        "access-window-end": string | null;
        "valid-until": string | null;
        "valid-from": string | null;
    };
    lastActive: number;
}

export type GuacamoleUsersResponse = Record<string, GuacamoleUser>;
export type GuacPermsObj = Record<string, string[]>;

export interface GuacamolePermsResponse {
    connectionPermissions: GuacPermsObj;
    connectionGroupPermissions: GuacPermsObj;
    sharingProfilePermissions: GuacPermsObj;
    activeConnectionPermissions: GuacPermsObj;
    userPermissions: GuacPermsObj;
    userGroupPermissions: GuacPermsObj;
    systemPermissions: GuacPermsObj;
}

export interface GuacamoleRdpParameters {
    port: string;
    "read-only": string;
    "swap-red-blue": string;
    cursor: string;
    "color-depth": string;
    "clipboard-encoding": string;
    "disable-copy": string;
    "disable-paste": string;
    "dest-port": string;
    "recording-exclude-output": string;
    "recording-exclude-mouse": string;
    "recording-include-keys": string;
    "create-recording-path": string;
    "enable-sftp": string;
    "sftp-port": string;
    "sftp-server-alive-interval": string;
    "enable-audio": string;
    security: string;
    "disable-auth": string;
    "ignore-cert": string;
    "gateway-port": string;
    "server-layout": string;
    timezone: string;
    console: string;
    width: string;
    height: string;
    dpi: string;
    "resize-method": string;
    "console-audio": string;
    "disable-audio": string;
    "enable-audio-input": string;
    "enable-printing": string;
    "enable-drive": string;
    "create-drive-path": string;
    "enable-wallpaper": string;
    "enable-theming": string;
    "enable-font-smoothing": string;
    "enable-full-window-drag": string;
    "enable-desktop-composition": string;
    "enable-menu-animations": string;
    "disable-bitmap-caching": string;
    "disable-offscreen-caching": string;
    "disable-glyph-caching": string;
    "preconnection-id": string;
    hostname: string;
    username: string;
    password: string;
    domain: string;
    "gateway-hostname": string;
    "gateway-username": string;
    "gateway-password": string;
    "gateway-domain": string;
    "initial-program": string;
    "client-name": string;
    "printer-name": string;
    "drive-name": string;
    "drive-path": string;
    "static-channels": string;
    "remote-app": string;
    "remote-app-dir": string;
    "remote-app-args": string;
    "preconnection-blob": string;
    "load-balance-info": string;
    "recording-path": string;
    "recording-name": string;
    "sftp-hostname": string;
    "sftp-host-key": string;
    "sftp-username": string;
    "sftp-password": string;
    "sftp-private-key": string;
    "sftp-passphrase": string;
    "sftp-root-directory": string;
    "sftp-directory": string;
}

export interface GuacamoleConnectionAttributes {
    "failover-only": string;
    "guacd-encryption": string;
    weight: string;
    "max-connections": string;
    "guacd-hostname": string;
    "guacd-port": string;
    "max-connections-per-user": string;
}

export interface GuacamoleConnection {
    name: string;
    identifier: string;
    parentIdentifier: string;
    protocol: string;
    parameters: GuacamoleRdpParameters;
    attributes: GuacamoleConnectionAttributes;
    activeConnections: number;
}

export interface GuacamoleConnectionSummary {
    name: string;
    identifier: string;
    parentIdentifier: string;
    protocol: string;
    attributes: {
        "guacd-encryption": string | null;
        "failover-only": string | null;
        weight: string | null;
        "max-connections": string | null;
        "guacd-hostname": string | null;
        "guacd-port": string | null;
        "max-connections-per-user": string | null;
    };
    activeConnections: number;
    lastActive?: number;
}

export type GuacamoleConnectionsResponse = Record<
    string,
    GuacamoleConnectionSummary
>;

export interface GuacamoleConnectionParameters {
    "color-depth": string;
    hostname: string;
    password: string;
    security: string;
    "ignore-cert": "true" | "false";
    port: string;
    "resize-method": string;
    username: string;
}
