// -----------------------------------------------------------
//  [*] Routes — auth: sessions, user admin, VU SSO
//
//  Mounted at /auth. Sessions are a JWT in an httpOnly
//  strict-samesite cookie (24 h); "logout" just clears it —
//  nothing is invalidated server-side. The SSO endpoints go
//  live only when SAML is configured, answering 503
//  otherwise.
//
//    GET    /auth                 — current session info
//    POST   /auth/login           — password login → cookie
//    POST   /auth/logout          — clear the cookie
//    POST   /auth/change-password — self-service change
//    POST   /auth/users           — bulk create (admin)
//    GET    /auth/users           — list users (admin)
//    GET    /auth/users/:vu_id    — one user (admin)
//    DELETE /auth/users/:vu_id    — delete user (admin)
//    PATCH  /auth/users/:vu_id    — password/role (admin)
//    GET    /auth/sso             — redirect to the VU IdP
//    POST   /auth/sso/callback    — SAML assertion consumer
//    GET    /auth/saml/metadata   — SP metadata XML
// -----------------------------------------------------------

import { Users } from "@/controllers/users.controller";
import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { validateRequest } from "@/middleware/zod-validation.middleware";
import { TokenPayload } from "@/types/auth";
import {
    changePasswordSchema,
    createUsersSchema,
    loginSchema,
    updateUserSchema,
    userParamsSchema,
} from "@/types/validators/auth.zod";
import { logger } from "@/utils/logger";
import { getSamlInstances, buildSpMetadata } from "@/utils/saml";
import { randomBytes } from "crypto";

import express, { Router } from "express";
import jwt from "jsonwebtoken";

const router = Router();








// -----------------------------------------------------------
// GET /auth
// -----------------------------------------------------------
//
// Who am I: the token's identity plus profile extras
// (last_login, has_password — false for SSO-only accounts,
// which hides the password-change UI).
//
// Used by:
//   - AuthGuard.tsx — the session check on every page
//   - PageLayout.tsx, Settings.tsx
// -----------------------------------------------------------

router.get("/", isAuthenticated, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const profile = await Users.getProfile(req.user.vu_id);

    res.json({
        vu_id: req.user.vu_id,
        role: req.user.role,
        last_login: profile?.last_login ?? null,
        has_password: profile?.has_password ?? false,
    });
});








// -----------------------------------------------------------
// POST /auth/login
// -----------------------------------------------------------
//
// Password login → 24 h JWT cookie. The response body also
// carries the payload so the SPA can render without a
// second round trip.
//
// Used by:
//   - Login.tsx — the password form
// -----------------------------------------------------------

router.post(
    "/login",
    validateRequest({ body: loginSchema }),
    async (req, res) => {
        try {
            const { username, password } = req.body;
            const user = await Users.passwordLogin(username, password);

            if (!user) {
                return res
                    .status(401)
                    .json({ error: "Invalid username or password" });
            }

            const tokenPayload: TokenPayload = {
                vu_id: user.vu_id,
                role: user.role,
            };

            const token = jwt.sign(
                tokenPayload,
                process.env.BACKEND_JWT_SECRET as string,
                {
                    expiresIn: "24h",
                },
            );

            res.cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "strict",
            }).json({ message: "Login successful", user: tokenPayload });
        } catch (err) {
            logger.error(err, "Error during login:");
            res.status(500).json({ error: "Login failed" });
        }
    },
);








// -----------------------------------------------------------
// POST /auth/logout
// -----------------------------------------------------------
//
// Clears the cookie; the JWT itself stays valid until it
// expires — there is no server-side revocation.
//
// Used by:
//   - PageLayout.tsx — the logout button
// -----------------------------------------------------------

router.post("/logout", isAuthenticated, (req, res) => {
    res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
    }).json({ message: "Logout successful" });
});








// -----------------------------------------------------------
// POST /auth/change-password
// -----------------------------------------------------------
//
// Re-proves the current password through the same login
// path before writing the new one.
//
// Used by:
//   - Settings.tsx — the password form
// -----------------------------------------------------------

router.post(
    "/change-password",
    isAuthenticated,
    validateRequest({ body: changePasswordSchema }),
    async (req, res) => {
        try {
            const user = req.user as TokenPayload;
            const { currentPassword, newPassword } = req.body;

            const isCurrentPasswordValid = await Users.passwordLogin(
                user.vu_id,
                currentPassword,
            );

            if (!isCurrentPasswordValid) {
                return res.status(401).json({ error: "Incorrect password" });
            }

            await Users.change(user.vu_id, newPassword);
            res.json({ message: "Password changed successfully" });
        } catch (err) {
            logger.error(err, "Error changing password:");
            res.status(500).json({ error: "Failed to change password" });
        }
    },
);








// -----------------------------------------------------------
// POST /auth/users
// -----------------------------------------------------------
//
// Bulk create, one result per requested user — a duplicate
// fails alone without sinking the batch. Users without a
// given password get a generated one, returned ONCE in this
// response and never retrievable again.
//
// Used by:
//   - admin/Users.tsx — the create-users dialog
// -----------------------------------------------------------

router.post(
    "/users",
    isAuthenticated,
    isAdmin,
    validateRequest({ body: createUsersSchema }),
    (req, res) => {
        const users = req.body.users as {
            vu_id: string;
            password?: string | null;
        }[];

        const results = users.map((user) => {
            let password = user.password;
            let wasPasswordGenerated = false;

            if (!password) {
                password = randomBytes(6).toString("hex").slice(0, 12);
                wasPasswordGenerated = true;
            }

            return Users.create(user.vu_id, password).then(
                (createdUser) => ({
                    vu_id: user.vu_id,
                    success: true,
                    data: {
                        vu_id: createdUser.vu_id,
                        role: createdUser.role,
                        password: wasPasswordGenerated ? password : undefined,
                    },
                }),
                (err) => ({
                    vu_id: user.vu_id,
                    success: false,
                    error: err.message || "Failed to create user",
                }),
            );
        });

        Promise.all(results)
            .then((finalResults) => res.json(finalResults))
            .catch((err) => {
                logger.error(err, "Error creating users:");
                res.status(500).json({ error: "Failed to create users" });
            });
    },
);








// -----------------------------------------------------------
// GET /auth/users
// -----------------------------------------------------------
//
// Used by:
//   - admin/Users.tsx — the users table
// -----------------------------------------------------------

router.get("/users", isAuthenticated, isAdmin, (req, res) => {
    Users.getAll()
        .then((users) => res.json(users))
        .catch((err) => {
            logger.error(err, "Error fetching users:");
            res.status(500).json({ error: "Failed to fetch users" });
        });
});








// -----------------------------------------------------------
// GET /auth/users/:vu_id
// -----------------------------------------------------------
//
// Used by:
//   - admin/Users.tsx
// -----------------------------------------------------------

router.get(
    "/users/:vu_id",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: userParamsSchema }),
    (req, res) => {
        const vu_id = Array.isArray(req.params.vu_id)
            ? req.params.vu_id[0]
            : req.params.vu_id;

        Users.getByVuId(vu_id)
            .then((user) => {
                if (!user) {
                    res.status(404).json({ error: "User not found" });
                } else {
                    res.json(user);
                }
            })
            .catch((err) => {
                logger.error(err, "Error fetching user:");
                res.status(500).json({ error: "Failed to fetch user" });
            });
    },
);








// -----------------------------------------------------------
// DELETE /auth/users/:vu_id
// -----------------------------------------------------------
//
// The heavyweight cascade lives in Users.delete: instances
// first, then the DB row, then the Guacamole account.
//
// Used by:
//   - admin/Users.tsx — the delete button
// -----------------------------------------------------------

router.delete(
    "/users/:vu_id",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: userParamsSchema }),
    (req, res) => {
        const vu_id = Array.isArray(req.params.vu_id)
            ? req.params.vu_id[0]
            : req.params.vu_id;

        Users.delete(vu_id)
            .then(() => res.json({ message: "User deleted successfully" }))
            .catch((err) => {
                logger.error(err, "Error deleting user:");
                res.status(500).json({ error: "Failed to delete user" });
            });
    },
);








// -----------------------------------------------------------
// PATCH /auth/users/:vu_id
// -----------------------------------------------------------
//
// Admin sets a new password and/or role.
//
// Used by:
//   - admin/Users.tsx — the edit dialog
// -----------------------------------------------------------

router.patch(
    "/users/:vu_id",
    isAuthenticated,
    isAdmin,
    validateRequest({ params: userParamsSchema, body: updateUserSchema }),
    async (req, res) => {
        const vu_id = Array.isArray(req.params.vu_id)
            ? req.params.vu_id[0]
            : req.params.vu_id;

        const { password, role } = req.body;

        try {
            const updated = await Users.update(vu_id, { password, role });
            res.json(updated);
        } catch (err) {
            logger.error(err, "Error updating user:");
            res.status(500).json({ error: "Failed to update user" });
        }
    },
);








// -----------------------------------------------------------
// GET /auth/sso
// -----------------------------------------------------------
//
// Starts the SAML dance: redirects the browser to the VU
// IdP with a login request.
//
// Used by:
//   - Login.tsx — the "VU SSO" button
// -----------------------------------------------------------

router.get("/sso", (req, res) => {
    const saml = getSamlInstances();
    if (!saml) {
        return res.status(503).json({ error: "SSO is not configured" });
    }
    const { context } = saml.sp.createLoginRequest(saml.idp, "redirect");
    res.redirect(context as string);
});








// -----------------------------------------------------------
// POST /auth/sso/callback
// -----------------------------------------------------------
//
// The assertion consumer the IdP posts back to. The user
// identity is eduPersonTargetedID (opaque, persistent,
// per-SP) with NameID as fallback; first login creates the
// account. Failures redirect to /login with an error flag
// rather than answering JSON — the browser is mid-redirect.
//
// Used by:
//   - the VU IdP (sso.vu.lt) — never called by our own UI
// -----------------------------------------------------------

router.post(
    "/sso/callback",
    express.urlencoded({ extended: false }),
    async (req, res) => {
        const saml = getSamlInstances();
        if (!saml) {
            return res.status(503).json({ error: "SSO is not configured" });
        }
        try {
            const { extract } = await saml.sp.parseLoginResponse(
                saml.idp,
                "post",
                req,
            );

            // eduPersonTargetedID — opaque persistent per-SP identifier (preferred)
            // Falls back to NameID (persistent format) if not present as attribute
            const attrs = extract.attributes as Record<string, string | string[]>;
            const raw =
                attrs["urn:oid:1.3.6.1.4.1.5923.1.1.1.10"] ??
                extract.nameID;
            const vu_id = Array.isArray(raw) ? raw[0] : raw;

            if (!vu_id) {
                logger.warn({ extract }, "SAML response missing user identifier");
                return res.redirect("/login?error=sso_failed");
            }

            const user = await Users.upsertSsoUser(vu_id);

            const tokenPayload: TokenPayload = {
                vu_id: user.vu_id,
                role: user.role,
            };

            const token = jwt.sign(
                tokenPayload,
                process.env.BACKEND_JWT_SECRET as string,
                { expiresIn: "24h" },
            );

            res.cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "strict",
            }).redirect("/");
        } catch (err) {
            logger.error(err, "SAML callback error");
            res.redirect("/login?error=sso_failed");
        }
    },
);








// -----------------------------------------------------------
// GET /auth/saml/metadata
// -----------------------------------------------------------
//
// The hand-built LITNET FEDI-compliant SP metadata XML.
//
// Used by:
//   - the federation registry — fetched during registration
// -----------------------------------------------------------

router.get("/saml/metadata", (req, res) => {
    const saml = getSamlInstances();
    if (!saml) {
        return res.status(503).json({ error: "SSO is not configured" });
    }
    res.type("application/xml").send(buildSpMetadata(saml.signingCert));
});








export { router as authRouter };
