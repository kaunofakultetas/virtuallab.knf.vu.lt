// -----------------------------------------------------------
//  [*] Controllers — Users: the users table DAO
//
//  Account management around the vu_id identity. Two kinds
//  of account live in one table: password accounts (bcrypt
//  hash stored) and SSO accounts (password NULL) — the NULL
//  is what passwordLogin and getProfile branch on.
//
//  delete() is the heavyweight, and its ORDER is the whole
//  design: two foreign keys to users(vu_id) are ON DELETE
//  RESTRICT, so the blockers are cleared (audit rows
//  reattributed, network groups released) before the DELETE
//  is attempted. A failed instance delete is fatal; a failed
//  Guacamole cleanup only logs, since the DB row is gone by
//  then and nothing else can retry it.
//
//  Used by:
//    - auth.route.ts — every login/user-admin endpoint
// -----------------------------------------------------------

import { ExtendedUser, User, UserRole } from "@/types/auth";
import { Instances } from "@/controllers/instances.controller";
import { DELETED_USER_PRINCIPAL } from "@/controllers/deleted-user-principal";
import { releaseNetworkGroupAfterInstance } from "@/network/provisioning-teardown";
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
            // 23505 = unique violation — the vu_id is taken.
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

        // Fire-and-forget: the login answer must not wait on the timestamp.
        this.updateLastLogin(user.vu_id).then(() => {});

        return {
            vu_id: user.vu_id,
            role: user.role,
        };
    },

    // First SSO login creates the account (password NULL); later logins just
    // bump last_login. Always a student — roles are granted by an admin.
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

    // The Guacamole credential, kept deliberately apart from the bcrypt
    // `password` above: that one verifies a human, this one is presented BY the
    // backend TO Guacamole, so it has to be recoverable. NULL means the account
    // predates the rotation and still has the old vu_id-derived password in
    // Guacamole — instances.route.ts mints a real one on the next connect.
    //
    // Deliberately absent from getAll / getByVuId / getProfile, which are
    // column-listed and must stay that way: no API returns this value.
    async getGuacPassword(vu_id: string): Promise<string | null> {
        const res = await pool.query<{ guac_password: string | null }>(
            `SELECT guac_password FROM users WHERE vu_id = $1`,
            [vu_id],
        );

        return res.rows[0]?.guac_password ?? null;
    },

    async setGuacPassword(vu_id: string, secret: string): Promise<void> {
        await pool.query(`UPDATE users SET guac_password = $1 WHERE vu_id = $2`, [
            secret,
            vu_id,
        ]);
    },

    // Ordered so the DELETE can actually succeed. Two foreign keys to
    // users(vu_id) are ON DELETE RESTRICT, and the previous order cleared
    // neither: it destroyed the VMs first and only then ran a DELETE that was
    // guaranteed to fail for any real user, leaving the account -- and its
    // still-valid 24 h sessions -- behind with nothing to own.
    //
    //   network_reconciliation_attempts.requested_by  — never deleted anywhere,
    //       and every user who provisioned an isolated VM owns rows. Cleared in
    //       step 2 by reattributing them to the tombstone principal.
    //   network_groups.owner_id                       — cleared in step 3, by
    //       releasing each group. deleteInstance alone only drops `planned`
    //       groups, so a user whose group ever reached `active` was undeletable.
    async delete(vu_id: string): Promise<boolean> {
        // 1. Nothing to destroy for an account that is not there. Checked first
        //    so a mistyped vu_id cannot delete somebody's VMs and then 404.
        const existing = await pool.query(
            `SELECT 1 FROM users WHERE vu_id = $1`,
            [vu_id],
        );
        if (existing.rowCount === 0) return false;

        // 2. Reattribute the audit trail rather than deleting it: the
        //    reconciliations really did happen, they just no longer belong to a
        //    live account.
        await pool.query(
            `UPDATE network_reconciliation_attempts
                SET requested_by = $2
              WHERE requested_by = $1`,
            [vu_id, DELETED_USER_PRINCIPAL],
        );

        // 3. The irreversible step. Each instance is destroyed and then its
        //    network group released, which is what frees the second FK.
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

            // Attributed to the tombstone, NOT to vu_id: this records a new
            // reconciliation attempt, and naming the departing user would
            // recreate the very FK rows step 2 just cleared.
            await releaseNetworkGroupAfterInstance(
                instance.network_group_id,
                DELETED_USER_PRINCIPAL,
            );
        }

        const removed = await pool.query(`DELETE FROM users WHERE vu_id = $1`, [
            vu_id,
        ]);
        if (removed.rowCount === 0) {
            // Should be unreachable — step 1 saw the row and nothing else
            // deletes users. Reported rather than assumed away, because the
            // caller answers 200 on `true` and the VMs are already gone.
            logger.error(
                { vu_id },
                "User row vanished during deletion; their instances were already destroyed",
            );
            return false;
        }

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

    // Profile for the current user's settings page. has_password is false for
    // SSO-only accounts (password column NULL), which can't change a password.
    async getProfile(vu_id: string): Promise<{
        vu_id: string;
        role: string;
        last_login: string | null;
        has_password: boolean;
    } | null> {
        const res = await pool.query(
            `SELECT vu_id, role, last_login, (password IS NOT NULL) AS has_password
             FROM users WHERE vu_id = $1`,
            [vu_id],
        );

        if (res.rows.length === 0) {
            return null;
        }

        return res.rows[0];
    },
};
