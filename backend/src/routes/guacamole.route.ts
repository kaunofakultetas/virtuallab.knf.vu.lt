// -----------------------------------------------------------
//  [*] Routes — Guacamole admin view
//
//  Mounted at /guacamole. One read-only endpoint that
//  flattens the Guacamole connection list for the admin UI.
//
//    GET /guacamole/connections — admin connection table
// -----------------------------------------------------------

import { guacamole } from "@/guacamole";
import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { logger } from "@/utils/logger";
import { Router } from "express";

const router = Router();








// -----------------------------------------------------------
// GET /guacamole/connections
// -----------------------------------------------------------
//
// The full connection list, flattened to the fields the
// table shows (attributes unpacked, lastActive nullable).
//
// Used by:
//   - admin/Guacamole.tsx — the connections table
// -----------------------------------------------------------

router.get("/connections", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        const raw = await guacamole.listConnections();
        const connections = Object.values(raw).map((c) => ({
            identifier: c.identifier,
            name: c.name,
            parentIdentifier: c.parentIdentifier,
            protocol: c.protocol,
            activeConnections: c.activeConnections,
            lastActive: c.lastActive ?? null,
            maxConnections: c.attributes["max-connections"] || null,
            maxConnectionsPerUser:
                c.attributes["max-connections-per-user"] || null,
        }));
        return res.json(connections);
    } catch (err) {
        logger.error(err, "Error fetching Guacamole connections");
        return res.status(500).json({ error: "Failed to fetch connections" });
    }
});








export { router as guacamoleRouter };
