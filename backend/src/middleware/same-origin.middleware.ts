// -----------------------------------------------------------
//  [*] Middleware — same-origin enforcement
//
//  The CSRF defence for this API. The session cookie is
//  SameSite=Strict, but that is not sufficient here, because
//  SameSite is computed on the registrable domain and
//  DELIBERATELY IGNORES THE PORT. The VM web-UI proxy is
//  served from virtuallab.knf.vu.lt:8888 — the same site as
//  the app — and the content it serves comes from a student's
//  own VM, which they have root on. So a page there is
//  same-site with the session cookie and the browser attaches
//  it, and stripping the cookie upstream (the proxy already
//  does) changes nothing: browser JS never needs to read it.
//
//  Origin and Sec-Fetch-Site DO include the port, so they can
//  tell :8888 from :443 where SameSite cannot.
//
//  Sec-Fetch-Site is the load-bearing check. Browsers send it
//  on EVERY request — including <img>, <script> and form
//  posts, which carry no Origin — and it is a forbidden header
//  name, so page JavaScript cannot spoof it.
//
//  Absent headers are allowed through: that is curl, the
//  Prometheus scraper, and scripts/dev-remote.sh, none of
//  which are browsers, and none of which carry a cookie a
//  third party controls.
//
//  Used by:
//    - index.ts — registered before the routers
// -----------------------------------------------------------

import { NextFunction, Request, Response } from "express";
import { logger } from "@/utils/logger";


// Server-to-server callers that never carry a browser context. Caddy calls
// proxy-auth itself, and the health/metrics endpoints are scraped.
const EXEMPT_PATHS = new Set([
    "/health",
    "/metrics",
    "/instances/proxy-auth",
]);


// Unset in development, where the SPA is served from the Vite dev server on a
// different port and every request would otherwise look cross-origin.
const publicOrigin = process.env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");

if (!publicOrigin) {
    logger.warn(
        "PUBLIC_ORIGIN is unset — the Origin half of same-origin enforcement is disabled. " +
            "Set it to the canonical browser origin (e.g. https://virtuallab.knf.vu.lt) in production.",
    );
}


// Node lowercases header names but keeps repeats as an array; a repeated
// Origin or Sec-Fetch-Site is malformed, so the first value is the one to
// judge rather than a join of them.
const firstHeader = (value: string | string[] | undefined): string | null => {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
    return null;
};


export const sameOriginMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    if (EXEMPT_PATHS.has(req.path)) return next();

    const deny = (reason: string, value: string) => {
        logger.warn(
            { reason, value, method: req.method, url: req.originalUrl || req.url },
            "Rejected a cross-origin request",
        );
        return res.status(403).json({ error: "Cross-origin request rejected" });
    };

    // A cross-site TOP-LEVEL navigation that only reads is allowed through:
    // following a link to /guac/ or to a docs page is legitimate, and it cannot
    // change anything now that every state-changing route is POST/PATCH/DELETE.
    // Subresource and fetch/XHR requests get no such exemption, which is what
    // the :8888 attack would have to use.
    const isSafeNavigation =
        (req.method === "GET" || req.method === "HEAD") &&
        firstHeader(req.headers["sec-fetch-mode"]) === "navigate";

    // `none` is a direct navigation (address bar, bookmark) and is fine.
    // `same-origin` is the SPA. `same-site` and `cross-site` are not: the
    // former is exactly the :8888 case this exists to stop.
    const fetchSite = firstHeader(req.headers["sec-fetch-site"]);
    if (
        fetchSite &&
        fetchSite !== "same-origin" &&
        fetchSite !== "none" &&
        !isSafeNavigation
    ) {
        return deny("sec-fetch-site", fetchSite);
    }

    const origin = firstHeader(req.headers.origin);
    if (publicOrigin && origin && origin !== publicOrigin && !isSafeNavigation) {
        return deny("origin", origin);
    }

    return next();
};
