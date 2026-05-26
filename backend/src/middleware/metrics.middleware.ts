import { NextFunction, Request, Response } from "express";
import {
    httpInFlightRequests,
    httpRequestDurationSeconds,
    httpRequestsTotal,
} from "@/utils/metrics";

const routeLabel = (req: Request): string => {
    // Express fills route.path on matched requests; fall back to a coarse label
    // so unmatched URLs don't blow up label cardinality.
    const route = (req as Request & { route?: { path?: string } }).route?.path;
    if (route) {
        return `${req.baseUrl ?? ""}${route}` || route;
    }
    return req.path === "/metrics" || req.path === "/health" || req.path === "/"
        ? req.path
        : "unmatched";
};

export const metricsMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    if (req.path === "/metrics") return next();

    httpInFlightRequests.inc();
    const stopTimer = httpRequestDurationSeconds.startTimer();

    res.on("finish", () => {
        const labels = {
            method: req.method,
            route: routeLabel(req),
            status: String(res.statusCode),
        };
        httpRequestsTotal.inc(labels);
        stopTimer(labels);
        httpInFlightRequests.dec();
    });

    res.on("close", () => {
        // If the connection closed before finish fired, still decrement.
        if (!res.writableEnded) httpInFlightRequests.dec();
    });

    next();
};
