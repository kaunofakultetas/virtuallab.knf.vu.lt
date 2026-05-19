import { ExtendedUser, User, UserRole } from "@/types/auth";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
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

    async change(vu_id: string, newPassword: string): Promise<boolean> {
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await pool.query(`UPDATE users SET password = $1 WHERE vu_id = $2`, [
            hashedPassword,
            vu_id,
        ]);

        return true;
    },

    async delete(vu_id: string): Promise<boolean> {
        await pool.query(`DELETE FROM users WHERE vu_id = $1`, [vu_id]);
        return true;
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
