// -----------------------------------------------------------
//  [*] Validators — template request schemas
//
//  connection_config is deliberately loose (any string-keyed
//  record): its real shape depends on connection_type, and
//  the union lives in types/templates.ts — the route only
//  guarantees "an object".
//
//  Used by:
//    - templates.route.ts
// -----------------------------------------------------------

import z from "zod";

// Template IDs travel as digit strings (route params).
export const templateIdSchema = z
    .string()
    .min(1, "template_id is required")
    .regex(/^\d+$/, "template_id must be digits only");

export const templateTypeSchema = z.enum(["student_vm", "lab_vm"]);

export const connectionTypeSchema = z.enum(["guacamole", "ssh", "web"]);

export const templateParamsSchema = z.object({
    id: templateIdSchema,
});

const connectionConfigSchema = z.record(z.string(), z.unknown()).optional();

// POST /templates
export const createTemplateSchema = z.object({
    type: templateTypeSchema,
    name: z.string().min(1, "name is required"),
    proxmox_id: z.string().min(1, "proxmox_id is required"),
    description: z.string().optional(),
    connection_type: connectionTypeSchema.optional().default("guacamole"),
    connection_config: connectionConfigSchema,
});

// PATCH /templates/:id — everything optional, but not all absent
export const updateTemplateSchema = z
    .object({
        type: templateTypeSchema.optional(),
        name: z.string().min(1, "name is required").optional(),
        proxmox_id: z.string().min(1, "proxmox_id is required").optional(),
        description: z.string().optional(),
        visible_to_students: z.boolean().optional(),
        connection_type: connectionTypeSchema.optional(),
        connection_config: connectionConfigSchema,
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: "At least one field must be provided for update",
    });

export const templateDeleteParamsSchema = z.object({
    id: templateIdSchema,
});

export const templateValidateParamsSchema = z.object({
    id: templateIdSchema,
});
