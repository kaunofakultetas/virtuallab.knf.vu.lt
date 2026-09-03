// -----------------------------------------------------------
//  [*] Validators — auth request schemas
//
//  Everything auth.route.ts feeds through validateRequest.
//  vu_id is digits only — VU student numbers — and doubles
//  as the username field on login.
//
//  Used by:
//    - auth.route.ts — one schema per endpoint, named below
// -----------------------------------------------------------

import z from "zod";

// vu_id — non-empty, digits only.
export const vuIdSchema = z
    .string()
    .min(1, "vu_id is required")
    .regex(/^\d+$/, "vu_id must be digits only");

// Passwords — at least 6 characters, everywhere a password appears.
export const passwordSchema = z
    .string()
    .min(6, "password must be at least 6 characters long");

// POST /auth/login
export const loginSchema = z.object({
    username: vuIdSchema,
    password: passwordSchema,
});

// POST /auth/change-password
export const changePasswordSchema = z.object({
    currentPassword: passwordSchema,
    newPassword: passwordSchema,
});

// POST /auth/users — bulk user creation, capped at 100 per call
export const createUsersSchema = z.object({
    users: z
        .array(
            z.object({
                vu_id: vuIdSchema,
                password: passwordSchema.nullable().optional(), // password is optional, will be generated if not provided
            }),
        )
        .min(1, "Users array cannot be empty")
        .max(100, "Cannot create more than 100 users at once"),
});

// /auth/users/:vu_id — route params
export const userParamsSchema = z.object({
    vu_id: vuIdSchema,
});

// PATCH /auth/users/:vu_id — admin update
export const updateUserSchema = z.object({
    password: passwordSchema.optional(),
    role: z.enum(["admin", "student"]).optional(),
});
