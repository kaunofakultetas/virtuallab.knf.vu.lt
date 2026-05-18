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
    if (url.split("?")[0] === "/health") {
        return next();
    }

    const start = Date.now();

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
