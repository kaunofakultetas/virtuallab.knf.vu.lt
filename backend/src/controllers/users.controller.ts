import { ExtendedUser, User, UserRole } from "@/types/auth";
import { Instances } from "@/controllers/instances.controller";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { guacamole } from "@/guacamole";
import bcrypt from "bcryptjs";

export const Users = {
    async create(vu_id: string, password: string, role: UserRole = "student") {
        const hashedPassword = await bcrypt.hash(password, 10);

        try {
            const res = await pool.query(
                `INSERT INTO users (vu_id, password, role) VALUES ($1, $2, $3) RETURNING vu_id, role`,
                [vu_id, hashedPassword, role],
            );

            return res.rows[0];
        } catch (err) {
            if ((err as any).code === "23505") {
                throw new Error("User with this vu_id already exists");
            } else {
                logger.error(err, "Error creating user:");
                throw new Error("DB error while creating user");
            }
        }
    },

    async updateLastLogin(vu_id: string): Promise<any> {
        return pool.query(
            `UPDATE users SET last_login = NOW() WHERE vu_id = $1`,
            [vu_id],
        );
    },

    async passwordLogin(vu_id: string, password: string): Promise<User | null> {
        const res = await pool.query(
            `SELECT vu_id, password, role FROM users WHERE vu_id = $1`,
            [vu_id],
        );

        if (res.rows.length === 0) {
            return null;
        }

        const user = res.rows[0];

        // SSO-only users have no password set
        if (!user.password) {
            return null;
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            return null;
        }

        this.updateLastLogin(user.vu_id).then(() => {});

        return {
            vu_id: user.vu_id,
            role: user.role,
        };
    },

    async upsertSsoUser(vu_id: string): Promise<User> {
        const res = await pool.query(
            `INSERT INTO users (vu_id, password, role)
             VALUES ($1, NULL, 'student')
             ON CONFLICT (vu_id) DO UPDATE SET last_login = NOW()
             RETURNING vu_id, role`,
            [vu_id],
        );
        return res.rows[0] as User;
    },

    async change(vu_id: string, newPassword: string): Promise<boolean> {
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await pool.query(`UPDATE users SET password = $1 WHERE vu_id = $2`, [
            hashedPassword,
            vu_id,
        ]);

        return true;
    },

    async delete(vu_id: string): Promise<boolean> {
        const ownedInstances = await Instances.getAllForUser(vu_id);

        for (const instance of ownedInstances) {
            try {
                await Instances.deleteInstance(instance.id);
            } catch (err) {
                logger.error(
                    { err, vu_id, instanceId: instance.id },
                    "Failed to delete user's instance before user deletion",
                );
                throw new Error("Failed to delete user instances");
            }
        }

        await pool.query(`DELETE FROM users WHERE vu_id = $1`, [vu_id]);

        try {
            await guacamole.deleteUser(vu_id);
        } catch (err) {
            logger.warn({ err, vu_id }, "Failed to delete Guacamole user");
        }

        return true;
    },

    async update(
        vu_id: string,
        updates: { password?: string; role?: string },
    ): Promise<{ vu_id: string; role: string }> {
        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;

        if (updates.password) {
            const hashedPassword = await bcrypt.hash(updates.password, 10);
            fields.push(`password = $${idx++}`);
            values.push(hashedPassword);
        }

        if (updates.role) {
            fields.push(`role = $${idx++}`);
            values.push(updates.role);
        }

        if (fields.length === 0) {
            throw new Error("No fields to update");
        }

        values.push(vu_id);
        const res = await pool.query(
            `UPDATE users SET ${fields.join(", ")} WHERE vu_id = $${idx} RETURNING vu_id, role`,
            values,
        );

        return res.rows[0];
    },

    async getAll(): Promise<ExtendedUser[]> {
        const res = await pool.query(
            `SELECT vu_id, role, last_login, created_at FROM users`,
        );

        return res.rows as ExtendedUser[];
    },

    async getByVuId(vu_id: string): Promise<ExtendedUser | null> {
        const res = await pool.query(
            `SELECT vu_id, role, last_login, created_at FROM users WHERE vu_id = $1`,
            [vu_id],
        );

        if (res.rows.length === 0) {
            return null;
        }

        return res.rows[0] as ExtendedUser;
    },
};
