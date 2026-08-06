import z from "zod";

export const createInstanceSchema = z
    .object({
        profile_id: z.number().int().positive("profile_id must be a positive integer"),
        template_id: z
            .number()
            .int()
            .positive("template_id must be a positive integer"),
    })
    .strict();

export const instanceIdParamSchema = z.object({
    instanceId: z
        .string()
        .min(1, "instanceId is required")
        .regex(/^\d+$/, "instanceId must be a positive integer"),
});

export const setExpirableSchema = z.object({
    expirable: z.boolean(),
});
