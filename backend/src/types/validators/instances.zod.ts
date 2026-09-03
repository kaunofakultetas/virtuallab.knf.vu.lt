// -----------------------------------------------------------
//  [*] Validators — instance request schemas
//
//  Used by:
//    - instances.route.ts — create body, :instanceId params,
//      and the expirable toggle
// -----------------------------------------------------------

import z from "zod";

// POST /instances — .strict() so an unexpected field is an error, not noise
export const createInstanceSchema = z
    .object({
        profile_id: z.number().int().positive("profile_id must be a positive integer"),
        template_id: z
            .number()
            .int()
            .positive("template_id must be a positive integer"),
    })
    .strict();

// :instanceId route param — a string of digits, because params always
// arrive as strings
export const instanceIdParamSchema = z.object({
    instanceId: z
        .string()
        .min(1, "instanceId is required")
        .regex(/^\d+$/, "instanceId must be a positive integer"),
});

// PATCH .../expirable
export const setExpirableSchema = z.object({
    expirable: z.boolean(),
});
