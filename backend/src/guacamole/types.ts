export type GuacamoleHTTPMethod = "GET" | "POST";

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

export type GuacamoleUsersResponse = Record<
    string,
    {
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
>;
