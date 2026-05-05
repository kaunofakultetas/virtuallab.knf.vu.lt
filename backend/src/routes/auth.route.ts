import { Users } from "@/controllers/users.controller";
import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { TokenPayload } from "@/types/auth";
import { logger } from "@/utils/logger";
import { randomBytes } from "crypto";

import { Router } from "express";
import jwt from "jsonwebtoken";

const router = Router();

// Return info about current session
router.get("/", isAuthenticated, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  res.json({
    vu_id: req.user.vu_id,
    role: req.user.role,
  });
});

// Login with username and password, return JWT token
router.post("/login", async (req, res) => {
  if (!req.body.username || !req.body.password) {
    return res.status(400).json({ error: "Missing username or password" });
  }

  const { username, password } = req.body;
  const user = await Users.passwordLogin(username, password);

  if (!user) {
    return res.status(401).json({ error: "Invalid username or password" });
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

  res
    .cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    })
    .json({ message: "Login successful", user: tokenPayload });
});

// Logout, invalidate JWT token
router.post("/logout", isAuthenticated, (req, res) => {
  res
    .clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    })
    .json({ message: "Logout successful" });
});

// Change password
router.post("/change-password", isAuthenticated, async (req, res) => {
  const user = req.user as TokenPayload;

  if (!req.body.currentPassword || !req.body.newPassword) {
    return res
      .status(400)
      .json({ error: "Missing currentPassword or newPassword" });
  }

  const { currentPassword, newPassword } = req.body;

  const isCurrentPasswordValid = await Users.passwordLogin(
    user.vu_id,
    currentPassword,
  );

  if (!isCurrentPasswordValid) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  Users.change(user.vu_id, newPassword)
    .then(() => res.json({ message: "Password changed successfully" }))
    .catch((err) => {
      logger.error(err, "Error changing password:");
      res.status(500).json({ error: "Failed to change password" });
    });
});

// Create user(s) (admin only)
router.post("/users", isAuthenticated, isAdmin, (req, res) => {
  if (!req.body.users || !Array.isArray(req.body.users)) {
    return res
      .status(400)
      .json({ error: "Missing users array in request body" });
  }

  if (req.body.users.length === 0) {
    return res.status(400).json({ error: "Users array cannot be empty" });
  } else if (req.body.users.length > 100) {
    return res
      .status(400)
      .json({ error: "Cannot create more than 100 users at once" });
  }

  const users = req.body.users as {
    vu_id: string;
    password: string | null;
  }[];

  const results = users.map((user) => {
    // validate vu_id, must be non-empty str digits only
    if (
      !user.vu_id ||
      typeof user.vu_id !== "string" ||
      !/^\d+$/.test(user.vu_id)
    ) {
      return Promise.resolve({
        vu_id: user.vu_id,
        success: false,
        error: "Invalid vu_id, must be a non-empty string of digits",
      });
    }

    var password = user.password;
    var wasPasswordGenerated = false;

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
});

// Get all users (admin only)
router.get("/users", isAuthenticated, isAdmin, (req, res) => {
  Users.getAll()
    .then((users) => res.json(users))
    .catch((err) => {
      logger.error(err, "Error fetching users:");
      res.status(500).json({ error: "Failed to fetch users" });
    });
});

// Get user by ID (admin only)
router.get("/users/:vu_id", isAuthenticated, isAdmin, (req, res) => {
  const vu_id = req.params.vu_id as string;

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
});

// Delete user (admin only)
router.delete("/users/:vu_id", isAuthenticated, isAdmin, (req, res) => {
  const vu_id = req.params.vu_id as string;

  Users.delete(vu_id)
    .then(() => res.json({ message: "User deleted successfully" }))
    .catch((err) => {
      logger.error(err, "Error deleting user:");
      res.status(500).json({ error: "Failed to delete user" });
    });
});

export { router as authRouter };
