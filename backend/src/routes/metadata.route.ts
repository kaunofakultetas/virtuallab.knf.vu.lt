import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { validateRequest } from "@/middleware/zod-validation.middleware";
import {
    metadataKeyParamSchema,
    updateMetadataSchema,
} from "@/types/validators/metadata.zod";
import { logger } from "@/utils/logger";
import { metadata } from "@/utils/metadata";
import { getNetworkReadiness } from "@/network/readiness";
import { Router } from "express";

const router = Router();

// List all known settings with current values and defaults (admin only)
router.get("/", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        const entries = await metadata.getAll();
        res.json(entries);
    } catch (err) {
        logger.error(err, "Error fetching metadata settings");
        res.status(500).json({ error: "Failed to fetch settings" });
    }
});

// Update a setting value (admin only)
router.patch(
    "/:key",
    isAuthenticated,
    isAdmin,
    validateRequest({
        params: metadataKeyParamSchema,
        body: updateMetadataSchema,
    }),
    async (req, res) => {
        const key = Array.isArray(req.params.key)
            ? req.params.key[0]
            : req.params.key;

        if (!(key in metadata.defaults)) {
            return res.status(404).json({ error: "Unknown setting key" });
        }
        if (
            key === "settings.network.mode" &&
            req.body.value !== "legacy" &&
            req.body.value !== "dry-run" &&
            req.body.value !== "active"
        ) {
            return res.status(400).json({ error: "Invalid network mode" });
        }

        try {
            if (key === "settings.network.mode" && req.body.value === "active") {
                const readiness = await getNetworkReadiness();
                if (!readiness.ready_for_active) {
                    return res.status(409).json({
                        error: "Active networking readiness checks failed",
                        checks: readiness.checks.filter((check) => !check.ready),
                    });
                }
            }
            await metadata.set(key, req.body.value);
            res.json({ key, value: req.body.value });
        } catch (err) {
            logger.error(err, "Error updating metadata setting");
            res.status(500).json({ error: "Failed to update setting" });
        }
    },
);

// Reset a setting to its default value (admin only)
router.delete(
    "/:key",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: metadataKeyParamSchema }),
    async (req, res) => {
        const key = Array.isArray(req.params.key)
            ? req.params.key[0]
            : req.params.key;

        if (!(key in metadata.defaults)) {
            return res.status(404).json({ error: "Unknown setting key" });
        }

        try {
            const defaultValue = metadata.defaults[key];
            await metadata.set(key, defaultValue);
            res.json({ key, value: defaultValue });
        } catch (err) {
            logger.error(err, "Error resetting metadata setting");
            res.status(500).json({ error: "Failed to reset setting" });
        }
    },
);

export { router as metadataRouter };
