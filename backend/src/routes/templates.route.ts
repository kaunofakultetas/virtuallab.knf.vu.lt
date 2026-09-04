// -----------------------------------------------------------
//  [*] Routes — templates
//
//  Mounted at /templates. Listing is role-aware; the rest is
//  admin CRUD plus a validation probe that checks the
//  backing Proxmox VM really is a template.
//
//    GET    /templates              — list (role-filtered)
//    GET    /templates/:id          — one template (admin)
//    POST   /templates              — create (admin)
//    DELETE /templates/:id          — delete (admin)
//    PATCH  /templates/:id          — update (admin)
//    GET    /templates/:id/validate — Proxmox-side check
// -----------------------------------------------------------

import { Instances } from "@/controllers/instances.controller";
import { Templates } from "@/controllers/templates.controller";
import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { validateRequest } from "@/middleware/zod-validation.middleware";
import { proxmox } from "@/proxmox";
import { ProxmoxApiError } from "@/proxmox/types";
import { CreateTemplateDTO, UpdateTemplateDTO } from "@/types/templates";
import {
    createTemplateSchema,
    templateDeleteParamsSchema,
    templateParamsSchema,
    templateValidateParamsSchema,
    updateTemplateSchema,
} from "@/types/validators/templates.zod";
import { logger } from "@/utils/logger";
import { Router } from "express";

const router = Router();








// -----------------------------------------------------------
// GET /templates
// -----------------------------------------------------------
//
// Admins get every template, students only the
// visible_to_students ones.
//
// Used by:
//   - Index.tsx — the student create flow
//   - admin/Templates.tsx, admin/AdminInstances.tsx,
//     admin/LabProfiles.tsx
// -----------------------------------------------------------

router.get("/", isAuthenticated, (req, res) => {
    if (req.user?.role === "admin") {
        Templates.getAll()
            .then((templates) => res.json(templates))
            .catch((err) => {
                logger.error(err, "Error fetching templates:");
                res.status(500).json({ error: "Failed to fetch templates" });
            });
    } else {
        Templates.getStudentTemplates()
            .then((templates) => res.json(templates))
            .catch((err) => {
                logger.error(err, "Error fetching templates:");
                res.status(500).json({ error: "Failed to fetch templates" });
            });
    }
});








// -----------------------------------------------------------
// GET /templates/:id
// -----------------------------------------------------------
//
// Used by:
//   - admin/TemplateDetails.tsx
// -----------------------------------------------------------

router.get(
    "/:id",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: templateParamsSchema }),
    (req, res) => {
        const idAsString = Array.isArray(req.params.id)
            ? req.params.id[0]
            : req.params.id;

        Templates.getById(parseInt(idAsString))
            .then((template) => {
                if (!template) {
                    res.status(404).json({ error: "Template not found" });
                } else {
                    res.json(template);
                }
            })
            .catch((err) => {
                logger.error(err, "Error fetching template:");
                res.status(500).json({ error: "Failed to fetch template" });
            });
    },
);








// -----------------------------------------------------------
// POST /templates
// -----------------------------------------------------------
//
// Rejects a duplicate proxmox_id up front. The optional
// connection_type/connection_config pass straight through to
// Templates.create, which defaults them to "guacamole" / {}.
//
// Used by:
//   - admin/Templates.tsx — the create dialog
// -----------------------------------------------------------

router.post(
    "/",
    isAuthenticated,
    isAdmin,
    validateRequest({ body: createTemplateSchema }),
    async (req, res) => {
        const {
            type,
            name,
            description,
            proxmox_id,
            connection_type,
            connection_config,
        } = req.body as CreateTemplateDTO;

        try {
            const existingTemplate = await Templates.getByProxmoxId(proxmox_id);
            if (existingTemplate != null) {
                return res.status(400).json({
                    error: "Template with this proxmox_id already exists",
                });
            }

            const template = await Templates.create({
                type,
                name,
                description,
                proxmox_id,
                connection_type,
                connection_config,
            });
            return res.status(201).json(template);
        } catch (err) {
            logger.error(err, "Error creating template:");
            return res.status(500).json({ error: "Failed to create template" });
        }
    },
);








// -----------------------------------------------------------
// DELETE /templates/:id
// -----------------------------------------------------------
//
// Used by:
//   - admin/Templates.tsx — the delete button
// -----------------------------------------------------------

router.delete(
    "/:id",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: templateDeleteParamsSchema }),
    (req, res) => {
        const idAsString = Array.isArray(req.params.id)
            ? req.params.id[0]
            : req.params.id;
        const id = parseInt(idAsString);

        Templates.delete(id)
            .then(() => res.status(204).send())
            .catch(async (err) => {
                // 23503 = foreign-key violation. instances.template_id is
                // ON DELETE RESTRICT, so a template still backing live VMs
                // cannot be removed -- deleting it used to null those rows out
                // and let the drift reconciler rewrite their firewalls to RDP.
                // Tell the admin what is holding it rather than answering 500.
                if ((err as { code?: string }).code === "23503") {
                    const dependants = await Instances.countByTemplate(id).catch(
                        () => null,
                    );
                    return res.status(409).json({
                        error: "Template is still in use",
                        message:
                            dependants === null
                                ? "Instances created from this template still exist. Delete them first."
                                : `${dependants} instance(s) created from this template still exist. Delete them first.`,
                    });
                }
                logger.error(err, "Error deleting template:");
                return res
                    .status(500)
                    .json({ error: "Failed to delete template" });
            });
    },
);








// -----------------------------------------------------------
// PATCH /templates/:id
// -----------------------------------------------------------
//
// Used by:
//   - admin/Templates.tsx, admin/TemplateDetails.tsx
// -----------------------------------------------------------

router.patch(
    "/:id",
    isAuthenticated,
    isAdmin,
    validateRequest({
        params: templateParamsSchema,
        body: updateTemplateSchema,
    }),
    (req, res) => {
        const idAsString = Array.isArray(req.params.id)
            ? req.params.id[0]
            : req.params.id;
        const id = parseInt(idAsString);
        const updates = req.body as UpdateTemplateDTO;

        Templates.update(id, updates)
            .then((updatedTemplate) => res.json(updatedTemplate))
            .catch((err) => {
                logger.error(err, "Error updating template:");
                res.status(500).json({ error: "Failed to update template" });
            });
    },
);








// -----------------------------------------------------------
// GET /templates/:id/validate
// -----------------------------------------------------------
//
// Checks the backing VM on the Proxmox side: it must exist
// and be a real template (template flag set); the
// template_image tag is only a warning. Proxmox errors are
// unwrapped so the UI can distinguish "VM gone" (404,
// PROXMOX_VM_NOT_FOUND) from "Proxmox broke" (502).
//
// Used by:
//   - admin/Templates.tsx / TemplateDetails.tsx — the
//     validate action
// -----------------------------------------------------------

router.get(
    "/:id/validate",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: templateValidateParamsSchema }),
    async (req, res) => {
        const idAsString = Array.isArray(req.params.id)
            ? req.params.id[0]
            : req.params.id;
        const id = parseInt(idAsString);

        let templateProxmoxId: string | null = null;

        try {
            const warnings: string[] = [];

            const template = await Templates.getById(id);
            if (!template) {
                return res.status(404).json({ error: "Template not found" });
            }

            const proxmox_id = template.proxmox_id;
            templateProxmoxId = proxmox_id;
            const status = await proxmox.getVm(proxmox_id);

            // Is container a template?
            if (status.template !== 1) {
                return res
                    .status(400)
                    .json({ error: "Proxmox container is not a template" });
            }

            // Does it have the template_image tag?
            if (!status.tags || !status.tags.includes("template_image")) {
                warnings.push(
                    "Proxmox container does not have the 'template_image' tag",
                );
            }

            return res.json({ valid: true, warnings });
        } catch (err) {
            logger.error(err, "Error validating template:");

            if (err instanceof ProxmoxApiError) {
                const details =
                    typeof err.details === "object" && err.details !== null
                        ? (err.details as Record<string, unknown>)
                        : null;
                const proxmoxMessage =
                    typeof details?.message === "string"
                        ? details.message
                        : null;
                const lowerMessage = proxmoxMessage?.toLowerCase() ?? "";

                // Proxmox answers "does not exist" as a 500, not a 404 —
                // translate it for the client.
                if (
                    err.status === 500 &&
                    lowerMessage.includes("does not exist")
                ) {
                    return res.status(404).json({
                        error: "Template VM not found in Proxmox",
                        message:
                            `Template with proxmox_id '${templateProxmoxId ?? "unknown"}' does not exist on the configured Proxmox node. ` +
                            "Verify the VM ID and node, or update the template record.",
                        code: "PROXMOX_VM_NOT_FOUND",
                        proxmox: {
                            path: err.path,
                            status: err.status,
                            message: proxmoxMessage,
                        },
                    });
                }

                return res.status(502).json({
                    error: "Proxmox validation failed",
                    message:
                        proxmoxMessage ??
                        "Proxmox returned an unexpected error while validating this template.",
                    code: "PROXMOX_VALIDATION_FAILED",
                    proxmox: {
                        path: err.path,
                        status: err.status,
                    },
                });
            }

            return res
                .status(500)
                .json({ error: "Failed to validate template" });
        }
    },
);








export { router as templatesRouter };
