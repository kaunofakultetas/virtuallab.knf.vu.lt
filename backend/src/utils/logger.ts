// -----------------------------------------------------------
//  [*] Utils — the shared pino logger
//
//  One logger for the whole backend. Transports are chosen
//  by environment: pretty-print everywhere except
//  production, plus a Loki push target whenever
//  LOGGING_LOKI_URL is set (basic auth from LOGGING_LOKI_*,
//  a custom push endpoint when the URL carries a path).
//  Authorization headers and password fields are redacted
//  before anything leaves the process.
//
//  Used by:
//    - nearly every module in the backend
// -----------------------------------------------------------

import pino, { type LoggerOptions, type TransportTargetOptions } from "pino";

const lokiBaseUrl = process.env.LOGGING_LOKI_URL?.trim();
const transportTargets: TransportTargetOptions[] = [];

if (process.env.NODE_ENV !== "production") {
    transportTargets.push({
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
        },
    });
}

if (lokiBaseUrl) {
    const parsedLokiUrl = new URL(lokiBaseUrl);
    const lokiOptions: Record<string, unknown> = {
        host: parsedLokiUrl.origin,
        basicAuth: {
            username: process.env.LOGGING_LOKI_USER,
            password: process.env.LOGGING_LOKI_PASS,
        },
        labels: {
            service: "virtual-proxmox-lab-backend",
            environment: process.env.NODE_ENV ?? "development",
        },
    };

    // pino-loki defaults to /loki/api/v1/push on the host; a URL with a path
    // (e.g. behind a reverse-proxy prefix) needs the endpoint spelled out.
    if (parsedLokiUrl.pathname && parsedLokiUrl.pathname !== "/") {
        lokiOptions.endpoint = `${parsedLokiUrl.pathname}/loki/api/v1/push`;
    }

    transportTargets.push({
        target: "pino-loki",
        options: lokiOptions,
    });
}

const loggerOptions: LoggerOptions = {
    level: process.env.LOG_LEVEL || "info",
    redact: ["req.headers.authorization", "password"],
};

if (transportTargets.length > 0) {
    loggerOptions.transport = {
        targets: transportTargets,
    };
}

export const logger = pino(loggerOptions);
