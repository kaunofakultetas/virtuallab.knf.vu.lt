// -----------------------------------------------------------
//  [*] Routes — lab profiles
//
//  Mounted at /lab-profiles. The listing is the only
//  student-reachable endpoint (students get a filtered
//  view); everything else is admin CRUD delegating to the
//  LabProfiles DAO.
//
//    GET    /lab-profiles     — list (students: filtered)
//    GET    /lab-profiles/:id — one profile (admin)
//    POST   /lab-profiles     — create (admin)
//    PATCH  /lab-profiles/:id — update (admin)
//    DELETE /lab-profiles/:id — delete (admin, non-default)
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// GET /lab-profiles
// -----------------------------------------------------------
//
// Admins see everything; a non-admin caller gets only
// profiles with student-visible templates.
//
// Used by:
//   - Instances.tsx — the create-instance profile picker
//   - admin/LabProfiles.tsx, admin/AdminInstances.tsx
// -----------------------------------------------------------

router.get("/", isAuthenticated, async (req, res) => {
    try {
        const profiles = await LabProfiles.getAll(req.user?.role !== "admin");
        return res.json(profiles);
    } catch (error) {
        logger.error(error, "Error fetching lab profiles");
        return res.status(500).json({ error: "Failed to fetch lab profiles" });
    }
});








// -----------------------------------------------------------
// GET /lab-profiles/:id
// -----------------------------------------------------------
//
// Used by:
//   - admin/LabProfiles.tsx
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// POST /lab-profiles
// -----------------------------------------------------------
//
// Used by:
//   - admin/LabProfiles.tsx — the create dialog
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// PATCH /lab-profiles/:id
// -----------------------------------------------------------
//
// Used by:
//   - admin/LabProfiles.tsx — the edit dialog
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// DELETE /lab-profiles/:id
// -----------------------------------------------------------
//
// Three outcomes from the DAO map to three statuses: 404
// unknown, 409 for the protected default profile, 204 done.
// The catch-all 409 covers FK violations — a profile still
// referenced by live network groups.
//
// Used by:
//   - admin/LabProfiles.tsx — the delete button
// -----------------------------------------------------------

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
