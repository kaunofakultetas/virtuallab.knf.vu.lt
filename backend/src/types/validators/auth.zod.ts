import z from "zod";

// Schema for vu_id - must be a non-empty string, digits only
export const vuIdSchema = z
  .string()
  .min(1, "vu_id is required")
  .regex(/^\d+$/, "vu_id must be digits only");

// Schema for password - must be a non-empty string, at least 6 characters long
export const passwordSchema = z
  .string()
  .min(6, "password must be at least 6 characters long");

// Schema for /auth/login endpoint
export const loginSchema = z.object({
  username: vuIdSchema,
  password: passwordSchema,
});

// Schema for /auth/change-password endpoint
export const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

// Schema for POST /auth/users endpoint (user creation)
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

// Schema for /auth/users/:vu_id endpoint (route params)
export const userParamsSchema = z.object({
  vu_id: vuIdSchema,
});
