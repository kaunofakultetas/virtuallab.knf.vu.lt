import z from "zod";

export const createInstanceSchema = z.object({
    template_id: z.number().min(0, "template_id is required"),
});

export const instanceIdParamSchema = z.object({
    instanceId: z
        .string()
        .min(1, "instanceId is required")
        .regex(/^\d+$/, "instanceId must be a positive integer"),
});

export const setExpirableSchema = z.object({
    expirable: z.boolean(),
});
