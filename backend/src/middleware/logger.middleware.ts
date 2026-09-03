// -----------------------------------------------------------
//  [*] Middleware — per-request access logging
//
//  One structured log line per completed request: method,
//  URL, status, duration, client IP, user and request ID.
//  /health, /metrics and /auth are skipped — the first two
//  are scraped constantly and would drown the log, and
//  /auth would log credentials-adjacent traffic for no gain.
//
//  Used by:
//    - index.ts — registered before the routes
// -----------------------------------------------------------

import { NextFunction, Request, Response } from "express";
import { logger } from "@/utils/logger";

type RequestWithId = Request & {
    id?: string;
    user?: { vu_id?: string };
};


export const loggerMiddleware = (
    req: RequestWithId,
    res: Response,
    next: NextFunction,
) => {
    const url = req.originalUrl || req.url;
    if (["/health", "/metrics", "/auth"].includes(url.split("?")[0])) {
        return next();
    }

    const start = Date.now();

    // Logged on finish, not on entry, so status and duration are real.
    res.on("finish", () => {
        const duration = Date.now() - start;

        logger.info(
            {
                method: req.method,
                url,
                status: res.statusCode,
                duration: `${duration}ms`,
                ip: req.ip,
                userId: req.user?.vu_id,
                requestId:
                    req.id ??
                    (typeof req.headers["x-request-id"] === "string"
                        ? req.headers["x-request-id"]
                        : undefined),
            },
            "request completed",
        );
    });

    next();
};
