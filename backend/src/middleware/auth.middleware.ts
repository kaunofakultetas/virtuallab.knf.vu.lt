// -----------------------------------------------------------
//  [*] Middleware — authentication guards
//
//  The two route guards: isAuthenticated verifies the JWT
//  (cookie first, Authorization bearer as fallback) and
//  hangs the decoded payload on req.user; isAdmin then
//  checks the role — it assumes isAuthenticated already ran,
//  as it reads req.user and never verifies anything itself.
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

import { TokenPayload } from "@/types/auth";


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


export const isAdmin: RequestHandler = (req, res, next) => {
    if (req.user?.role === "admin") {
        next();
    } else {
        return res.status(403).json({ message: "Forbidden" });
    }
};
