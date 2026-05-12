import { Templates } from "@/controllers/templates.controller";
import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { validateRequest } from "@/middleware/zod-validation.middleware";
import { proxmox } from "@/proxmox";
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

// Get all Templates the User has access to
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

// Get Template by ID
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

// Create a new Template
router.post(
  "/",
  isAuthenticated,
  isAdmin,
  validateRequest({ body: createTemplateSchema }),
  async (req, res) => {
    const { type, name, description, proxmox_id } =
      req.body as CreateTemplateDTO;

    try {
      const existingTemplate = await Templates.getByProxmoxId(proxmox_id);
      if (existingTemplate != null) {
        return res
          .status(400)
          .json({ error: "Template with this proxmox_id already exists" });
      }

      const template = await Templates.create({
        type,
        name,
        description,
        proxmox_id,
      });
      return res.status(201).json(template);
    } catch (err) {
      logger.error(err, "Error creating template:");
      return res.status(500).json({ error: "Failed to create template" });
    }
  },
);

// Delete a Template by ID
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
      .catch((err) => {
        logger.error(err, "Error deleting template:");
        res.status(500).json({ error: "Failed to delete template" });
      });
  },
);

// Update a Template by ID
router.patch(
  "/:id",
  isAuthenticated,
  isAdmin,
  validateRequest({ params: templateParamsSchema, body: updateTemplateSchema }),
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

// Validate template
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

    try {
      const warnings: string[] = [];

      const template = await Templates.getById(id);
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }

      const proxmox_id = template.proxmox_id;
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
      return res.status(500).json({ error: "Failed to validate template" });
    }
  },
);

export { router as templatesRouter };
