// -----------------------------------------------------------
//  [*] Routes — metadata: the admin settings API
//
//  Mounted at /metadata, admin-only throughout. Only keys
//  present in metadata.defaults exist as far as this API is
//  concerned; DELETE resets to the default rather than
//  removing the row, so a setting can never disappear.
//
//  Flipping settings.network.mode to "active" is special:
//  it is refused (409, with the failing checks) until the
//  network readiness report passes.
//
//    GET    /metadata      — all settings with defaults
//    PATCH  /metadata/:key — update one setting
//    DELETE /metadata/:key — reset one setting to default
//
//  Used by:
//    - admin/Settings.tsx — the settings page
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// GET /metadata
// -----------------------------------------------------------
//
// Every catalogued setting with its current value, default
// and last-updated stamp.
//
// Used by:
//   - admin/Settings.tsx — the settings table
// -----------------------------------------------------------

router.get("/", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        const entries = await metadata.getAll();
        res.json(entries);
    } catch (err) {
        logger.error(err, "Error fetching metadata settings");
        res.status(500).json({ error: "Failed to fetch settings" });
    }
});








// -----------------------------------------------------------
// PATCH /metadata/:key
// -----------------------------------------------------------
//
// Updates one known setting. The network-mode value is
// checked by hand here (the generic schema only knows
// "scalar"), and going active runs the full readiness
// report first — failing required checks come back in the
// 409 body so the UI can show WHY.
//
// Used by:
//   - admin/Settings.tsx — the edit dialog
// -----------------------------------------------------------

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

        // Type-check against the default's shape. The module comment in
        // utils/metadata.ts has always claimed this happened here; it did not,
        // and `metadata.get<T>` is a cast rather than a parse, so a wrong type
        // propagated silently to whatever read it. Two of the numeric limits
        // then failed OPEN:
        //   vmPerStudent = "unlimited"      -> `n >= NaN` is false -> no quota
        //   storageReserveBytes = "0"       -> capacity check never trips
        // Both ration a shared resource, and neither failure surfaced anywhere.
        const defaultValue = metadata.defaults[key];
        const value = req.body.value;

        if (Array.isArray(defaultValue)) {
            // No array-valued setting is editable through this endpoint: the
            // request schema only admits scalars. Reject rather than coerce.
            return res.status(400).json({
                error: `${key} is a list and cannot be set through this endpoint`,
            });
        }
        if (typeof value !== typeof defaultValue) {
            return res.status(400).json({
                error: `${key} must be a ${typeof defaultValue}`,
            });
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
            return res.status(400).json({ error: `${key} must be a finite number` });
        }

        // The limits that ration shared resources additionally may not be
        // negative -- a negative reserve or quota disables the check it exists
        // to perform.
        const NON_NEGATIVE_KEYS = [
            "settings.limits.vmPerStudent",
            "settings.limits.maxRuntimeHours",
            "settings.proxmox.storageReserveBytes",
            "settings.proxmox.minVmId",
            "settings.instances.defaultRuntimeHours",
            "settings.instances.ipWaitTimeoutMs",
            "settings.instances.ipPollIntervalMs",
            "settings.guacamole.requestTimeoutMs",
        ];
        if (NON_NEGATIVE_KEYS.includes(key) && (value as number) < 0) {
            return res
                .status(400)
                .json({ error: `${key} must not be negative` });
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
                        checks: readiness.checks.filter(
                            (check) => check.required && check.status !== "pass",
                        ),
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








// -----------------------------------------------------------
// DELETE /metadata/:key
// -----------------------------------------------------------
//
// "Reset", not delete: writes the default value back, so
// the row keeps existing and getAll() stays complete.
//
// Used by:
//   - admin/Settings.tsx — the reset button
// -----------------------------------------------------------

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
