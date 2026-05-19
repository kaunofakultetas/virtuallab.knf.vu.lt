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

    if (parsedLokiUrl.pathname && parsedLokiUrl.pathname !== "/") {
        lokiOptions.endpoint = `${parsedLokiUrl.pathname}${parsedLokiUrl.search}`;
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
