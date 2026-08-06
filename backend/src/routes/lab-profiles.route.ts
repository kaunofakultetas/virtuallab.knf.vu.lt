import { LabProfiles } from "@/controllers/lab-profiles.controller";
import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { validateRequest } from "@/middleware/zod-validation.middleware";
import {
    CreateLabProfileDTO,
    UpdateLabProfileDTO,
} from "@/types/lab-profiles";
import {
    createLabProfileSchema,
    labProfileParamsSchema,
    updateLabProfileSchema,
} from "@/types/validators/lab-profiles.zod";
import { logger } from "@/utils/logger";
import { Router } from "express";

const router = Router();

router.get("/", isAuthenticated, async (req, res) => {
    try {
        const profiles = await LabProfiles.getAll(req.user?.role !== "admin");
        return res.json(profiles);
    } catch (error) {
        logger.error(error, "Error fetching lab profiles");
        return res.status(500).json({ error: "Failed to fetch lab profiles" });
    }
});

router.get(
    "/:id",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: labProfileParamsSchema }),
    async (req, res) => {
        try {
            const profile = await LabProfiles.getById(Number(req.params.id));
            return profile
                ? res.json(profile)
                : res.status(404).json({ error: "Lab profile not found" });
        } catch (error) {
            logger.error(error, "Error fetching lab profile");
            return res.status(500).json({ error: "Failed to fetch lab profile" });
        }
    },
);

router.post(
    "/",
    isAuthenticated,
    isAdmin,
    validateRequest({ body: createLabProfileSchema }),
    async (req, res) => {
        try {
            const profile = await LabProfiles.create(
                req.body as CreateLabProfileDTO,
            );
            return res.status(201).json(profile);
        } catch (error) {
            logger.error(error, "Error creating lab profile");
            return res.status(400).json({ error: "Failed to create lab profile" });
        }
    },
);

router.patch(
    "/:id",
    isAuthenticated,
    isAdmin,
    validateRequest({
        params: labProfileParamsSchema,
        body: updateLabProfileSchema,
    }),
    async (req, res) => {
        try {
            const profile = await LabProfiles.update(
                Number(req.params.id),
                req.body as UpdateLabProfileDTO,
            );
            return profile
                ? res.json(profile)
                : res.status(404).json({ error: "Lab profile not found" });
        } catch (error) {
            logger.error(error, "Error updating lab profile");
            return res.status(400).json({ error: "Failed to update lab profile" });
        }
    },
);

router.delete(
    "/:id",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: labProfileParamsSchema }),
    async (req, res) => {
        try {
            const result = await LabProfiles.delete(Number(req.params.id));
            if (result === "not_found") {
                return res.status(404).json({ error: "Lab profile not found" });
            }
            if (result === "default") {
                return res.status(409).json({
                    error: "The default lab profile cannot be deleted",
                });
            }
            return res.status(204).send();
        } catch (error) {
            logger.error(error, "Error deleting lab profile");
            return res.status(409).json({
                error: "Lab profile is still in use and cannot be deleted",
            });
        }
    },
);

export { router as labProfilesRouter };