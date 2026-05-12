import z from "zod";

// Schema for template_id - must be a non-empty string, digits only
export const templateIdSchema = z
  .string()
  .min(1, "template_id is required")
  .regex(/^\d+$/, "template_id must be digits only");

export const templateTypeSchema = z.enum(["student_vm", "lab_vm"]);

// Schema for GET /templates/:id endpoint (route params)
export const templateParamsSchema = z.object({
  id: templateIdSchema,
});

// Schema for POST /templates/ endpoint (template creation)
export const createTemplateSchema = z.object({
  type: templateTypeSchema,
  name: z.string().min(1, "name is required"),
  proxmox_id: z.string().min(1, "proxmox_id is required"),
  description: z.string().optional(),
});

// Schema for PATCH /templates/:id endpoint (template update)
export const updateTemplateSchema = z
  .object({
    type: templateTypeSchema.optional(),
    name: z.string().min(1, "name is required").optional(),
    proxmox_id: z.string().min(1, "proxmox_id is required").optional(),
    description: z.string().optional(),
    visible_to_students: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });

// Schema for DELETE /templates/:id and GET /templates/:id/validate endpoint params
export const templateDeleteParamsSchema = z.object({
  id: templateIdSchema,
});

export const templateValidateParamsSchema = z.object({
  id: templateIdSchema,
});
