// -----------------------------------------------------------
//  [*] Controllers — Templates: the templates table DAO
//
//  Plain SQL access to `templates`. The one behavior worth
//  knowing: create() also links the new template to every
//  DEFAULT lab profile in the same transaction, so a fresh
//  template is usable without an admin touching profiles.
//
//  Used by:
//    - templates.route.ts — every endpoint
//    - instances.route.ts / instances.controller.ts —
//      template lookups before cloning
//    - lab-profiles.controller.ts
// -----------------------------------------------------------

import { UserRole } from "@/types/auth";
import {
    CreateTemplateDTO,
    Template,
    UpdateTemplateDTO,
} from "@/types/templates";
import { pool } from "@/utils/db";


export const Templates = {
    getAll: async (): Promise<Template[]> => {
        const res = await pool.query(`SELECT * FROM templates`);

        return res.rows as Template[];
    },

    getById: async (id: number): Promise<Template | null> => {
        const res = await pool.query(`SELECT * FROM templates WHERE id = $1`, [
            id,
        ]);

        return res.rows[0] as Template | null;
    },

    getStudentTemplates: async (): Promise<Template[]> => {
        const res = await pool.query(
            `SELECT * FROM templates WHERE visible_to_students = true`,
        );

        return res.rows as Template[];
    },

    getByProxmoxId: async (proxmoxId: string): Promise<Template | null> => {
        const res = await pool.query(
            `SELECT * FROM templates WHERE proxmox_id = $1`,
            [proxmoxId],
        );

        if (res.rows.length === 0) {
            return null;
        } else {
            return res.rows[0] as Template;
        }
    },

    // Admins see everything; students only what is flagged visible. An
    // unknown template ID answers false, not an error.
    hasAccess: async (role: UserRole, templateId: number): Promise<boolean> => {
        if (role === "admin") {
            return true;
        }

        const res = await pool.query(
            `SELECT visible_to_students FROM templates WHERE id = $1`,
            [templateId],
        );

        if (res.rows.length === 0) {
            return false;
        }

        return res.rows[0].visible_to_students;
    },

    // Insert + default-profile linking in one transaction: either the
    // template exists and is offered by the default profiles, or neither.
    create: async (template: CreateTemplateDTO): Promise<Template> => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const res = await client.query(
                `INSERT INTO templates (type, name, proxmox_id, description, connection_type, connection_config)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [
                    template.type,
                    template.name,
                    template.proxmox_id,
                    template.description || null,
                    template.connection_type ?? "guacamole",
                    JSON.stringify(template.connection_config ?? {}),
                ],
            );
            const created = res.rows[0] as Template;
            await client.query(
                `INSERT INTO lab_profile_templates (profile_id, template_id)
                 SELECT id, $1 FROM lab_profiles WHERE is_default = TRUE
                 ON CONFLICT DO NOTHING`,
                [created.id],
            );
            await client.query("COMMIT");
            return created;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    delete: async (id: number): Promise<void> => {
        await pool.query(`DELETE FROM templates WHERE id = $1`, [id]);
    },

    // Dynamic SET list from whatever fields the DTO carries; the zod layer
    // upstream is what keeps the keys trustworthy enough to interpolate.
    update: async (
        id: number,
        updates: UpdateTemplateDTO,
    ): Promise<Template> => {
        const fields = [];
        const values = [];
        let idx = 1;

        for (const [key, value] of Object.entries(updates)) {
            if (key === "connection_config") {
                fields.push(`${key} = $${idx}::jsonb`);
                values.push(JSON.stringify(value));
            } else {
                fields.push(`${key} = $${idx}`);
                values.push(value);
            }
            idx++;
        }

        if (fields.length === 0) {
            throw new Error("No fields to update");
        }

        values.push(id); // Add ID as the last parameter

        const res = await pool.query(
            `UPDATE templates SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
            values,
        );

        return res.rows[0] as Template;
    },
};
