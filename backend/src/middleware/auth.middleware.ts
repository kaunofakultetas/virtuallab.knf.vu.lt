// -----------------------------------------------------------
//  [*] Middleware — authentication guards
//
//  The two route guards: isAuthenticated verifies the JWT
//  (cookie first, Authorization bearer as fallback) and
//  hangs the decoded payload on req.user; isAdmin then
//  re-reads the role FROM THE DATABASE, because the token
//  claim is up to 24 h stale and nothing can revoke it. It
//  assumes isAuthenticated already ran, as it takes the
//  identity from req.user and verifies no token itself.
//
//  A missing token answers 401; a bad token or wrong role
//  answers 403.
//
//  Used by:
//    - every route file except the public parts of
//      auth.route.ts and metadata/metrics token endpoints
// -----------------------------------------------------------

import jwt from "jsonwebtoken";
import { RequestHandler } from "express";

import { TokenPayload, UserRole } from "@/types/auth";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";


export const isAuthenticated: RequestHandler = (req, res, next) => {
    const token = req.cookies.token || req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    try {
        const decoded = jwt.verify(
            token,
            process.env.BACKEND_JWT_SECRET as string,
        ) as TokenPayload;

        if (!decoded || !decoded.vu_id) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ message: "Forbidden" });
    }
};


// Reads the role from the DATABASE, not from the token claim. The claim is up
// to 24 hours stale and there is no revocation of any kind -- no deny list, no
// token version, no session table -- so trusting it meant an administrator
// demoted through PATCH /auth/users/:vu_id kept working admin access to every
// isAdmin route until their token happened to expire. Revoking a compromised or
// departing admin has to take effect when the admin says so.
//
// This matches what Instances.hasAccessTo already does; the two guards
// disagreeing about WHEN they read the role was the actual bug.
export const isAdmin: RequestHandler = async (req, res, next) => {
    const vu_id = req.user?.vu_id;
    if (!vu_id) {
        return res.status(403).json({ message: "Forbidden" });
    }

    try {
        const result = await pool.query<{ role: UserRole }>(
            `SELECT role FROM users WHERE vu_id = $1`,
            [vu_id],
        );

        if (result.rows[0]?.role !== "admin") {
            return res.status(403).json({ message: "Forbidden" });
        }

        // Keep the request's view of itself consistent with the check just
        // made: handlers branch on req.user.role (templates.route.ts and
        // lab-profiles.route.ts filter their responses by it).
        if (req.user) req.user.role = result.rows[0].role;

        return next();
    } catch (err) {
        // Fail closed. An unreachable database must not grant admin.
        logger.error({ err, vu_id }, "Failed to verify admin role");
        return res.status(503).json({ message: "Service Unavailable" });
    }
};
