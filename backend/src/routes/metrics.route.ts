import { NextFunction, Request, Response, Router } from "express";
import { logger } from "@/utils/logger";
import { registry } from "@/utils/metrics";

export const metricsRouter = Router();

const expectedToken = process.env.METRICS_TOKEN?.trim();

if (!expectedToken) {
    logger.warn(
        "METRICS_TOKEN is unset — /metrics is publicly readable. Set METRICS_TOKEN to require a bearer token.",
    );
}

const requireToken = (req: Request, res: Response, next: NextFunction) => {
    if (!expectedToken) return next();

    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match && match[1] === expectedToken) return next();

    res.setHeader("WWW-Authenticate", 'Bearer realm="metrics"');
    res.status(401).send("unauthorized");
};

metricsRouter.get("/", requireToken, async (_req: Request, res: Response) => {
    res.setHeader("Content-Type", registry.contentType);
    res.status(200).send(await registry.metrics());
});
