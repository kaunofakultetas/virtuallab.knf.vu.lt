import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { getNetworkReadiness } from "@/network/readiness";
import { logger } from "@/utils/logger";
import { Router } from "express";

const router = Router();

router.get("/readiness", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await getNetworkReadiness());
    } catch (error) {
        logger.error(error, "Error evaluating network readiness");
        return res.status(500).json({ error: "Failed to evaluate network readiness" });
    }
});

export { router as networkRouter };