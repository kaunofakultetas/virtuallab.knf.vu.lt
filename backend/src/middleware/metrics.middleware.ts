// -----------------------------------------------------------
//  [*] Middleware — HTTP request metrics
//
//  Feeds the three HTTP metrics in utils/metrics.ts: the
//  request counter, the duration histogram and the in-flight
//  gauge. /metrics itself is excluded so the scraper does
//  not count its own scrapes.
//
//  Used by:
//    - index.ts — registered before the routes
// -----------------------------------------------------------

import { NextFunction, Request, Response } from "express";
import {
    httpInFlightRequests,
    httpRequestDurationSeconds,
    httpRequestsTotal,
} from "@/utils/metrics";


// Express fills route.path on matched requests; fall back to a coarse label
// so unmatched URLs don't blow up label cardinality.
const routeLabel = (req: Request): string => {
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
