export type GuacamoleHTTPMethod = "GET" | "POST";

export interface GuacamoleClientConfig {
  baseUrl: string;
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
