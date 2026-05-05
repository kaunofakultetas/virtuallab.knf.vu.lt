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
    const res = await pool.query(`SELECT * FROM templates WHERE id = $1`, [id]);

    return res.rows[0] as Template | null;
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

  create: async (template: CreateTemplateDTO): Promise<Template> => {
    const res = await pool.query(
      `INSERT INTO templates (type, name, proxmox_id, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        template.type,
        template.name,
        template.proxmox_id,
        template.description || null,
      ],
    );

    return res.rows[0] as Template;
  },

  delete: async (id: number): Promise<void> => {
    await pool.query(`DELETE FROM templates WHERE id = $1`, [id]);
  },

  update: async (id: number, updates: UpdateTemplateDTO): Promise<Template> => {
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${idx}`);
      values.push(value);
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
