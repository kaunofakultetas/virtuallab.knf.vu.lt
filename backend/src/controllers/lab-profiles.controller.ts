// -----------------------------------------------------------
//  [*] Controllers — LabProfiles: the lab_profiles DAO
//
//  Profiles span three tables: lab_profiles itself,
//  allowed_web_domains and lab_profile_templates. Writes
//  replace the child sets wholesale inside one transaction;
//  reads hydrate the children back in with two batched
//  queries. The default profile cannot be deleted.
//
//  Split into (aggregate last):
//
//    replaceDomains   — child-table rewrite (domains)
//    replaceTemplates — child-table rewrite (templates)
//    hydrateProfiles  — rows → full LabProfile objects
//    LabProfiles      — the exported DAO
//
//  Used by:
//    - lab-profiles.route.ts — every endpoint
//    - instances.route.ts — profile lookup on create
// -----------------------------------------------------------

import {
    AllowedWebDomain,
    CreateLabProfileDTO,
    LabProfile,
    UpdateLabProfileDTO,
} from "@/types/lab-profiles";
import { Template } from "@/types/templates";
import { pool } from "@/utils/db";
import { PoolClient } from "pg";

type LabProfileRow = Omit<LabProfile, "domains" | "templates">;








// -----------------------------------------------------------
// replaceDomains
// -----------------------------------------------------------
//
// Delete-then-insert on the caller's transaction client, so
// the swap is atomic with the parent update.
//
// Used by:
//   - LabProfiles.create / update (below)
// -----------------------------------------------------------

async function replaceDomains(
    client: PoolClient,
    profileId: number,
    domains: AllowedWebDomain[],
): Promise<void> {
    await client.query(`DELETE FROM allowed_web_domains WHERE profile_id = $1`, [
        profileId,
    ]);

    for (const domain of domains) {
        await client.query(
            `INSERT INTO allowed_web_domains (profile_id, domain, include_subdomains)
             VALUES ($1, $2, $3)`,
            [profileId, domain.domain, domain.include_subdomains],
        );
    }
}








// -----------------------------------------------------------
// replaceTemplates
// -----------------------------------------------------------
//
// Same swap as replaceDomains, but existence-checked first:
// a dangling template ID fails the whole transaction instead
// of silently shrinking the set.
//
// Used by:
//   - LabProfiles.create / update (below)
// -----------------------------------------------------------

async function replaceTemplates(
    client: PoolClient,
    profileId: number,
    templateIds: number[],
): Promise<void> {
    if (templateIds.length > 0) {
        const existing = await client.query<{ id: number }>(
            `SELECT id FROM templates WHERE id = ANY($1::int[])`,
            [templateIds],
        );
        if (existing.rowCount !== templateIds.length) {
            throw new Error("One or more templates do not exist");
        }
    }

    await client.query(`DELETE FROM lab_profile_templates WHERE profile_id = $1`, [
        profileId,
    ]);

    for (const templateId of templateIds) {
        await client.query(
            `INSERT INTO lab_profile_templates (profile_id, template_id)
             VALUES ($1, $2)`,
            [profileId, templateId],
        );
    }
}








// -----------------------------------------------------------
// hydrateProfiles
// -----------------------------------------------------------
//
// Attaches domains and templates to a batch of profile rows
// with two ANY($1) queries instead of 2×N. With
// studentVisibleOnly, hidden templates are filtered in SQL —
// the profile still hydrates, just with fewer templates.
//
// Used by:
//   - LabProfiles.getAll / getById (below)
// -----------------------------------------------------------

async function hydrateProfiles(
    rows: LabProfileRow[],
    studentVisibleOnly: boolean,
): Promise<LabProfile[]> {
    if (rows.length === 0) return [];

    const profileIds = rows.map(({ id }) => id);
    const [domainResult, templateResult] = await Promise.all([
        pool.query<AllowedWebDomain & { profile_id: number }>(
            `SELECT profile_id, domain, include_subdomains
             FROM allowed_web_domains
             WHERE profile_id = ANY($1::int[])
             ORDER BY domain`,
            [profileIds],
        ),
        pool.query<Template & { profile_id: number }>(
            `SELECT template.*, membership.profile_id
             FROM lab_profile_templates membership
             JOIN templates template ON template.id = membership.template_id
             WHERE membership.profile_id = ANY($1::int[])
               AND ($2::boolean = FALSE OR template.visible_to_students = TRUE)
             ORDER BY template.name`,
            [profileIds, studentVisibleOnly],
        ),
    ]);

    return rows.map((profile) => ({
        ...profile,
        domains: domainResult.rows
            .filter((domain) => domain.profile_id === profile.id)
            .map(({ domain, include_subdomains }) => ({
                domain,
                include_subdomains,
            })),
        templates: templateResult.rows
            .filter((template) => template.profile_id === profile.id)
            .map(({ profile_id: _profileId, ...template }) => template),
    }));
}








// -----------------------------------------------------------
// LabProfiles (the exported DAO)
// -----------------------------------------------------------
//
// Used by:
//   - lab-profiles.route.ts, instances.route.ts
// -----------------------------------------------------------

export const LabProfiles = {
    // For students, a profile with no visible templates disappears entirely —
    // there is nothing they could create from it.
    getAll: async (studentVisibleOnly = false): Promise<LabProfile[]> => {
        const result = await pool.query<LabProfileRow>(
            `SELECT * FROM lab_profiles ORDER BY is_default DESC, name`,
        );
        const profiles = await hydrateProfiles(result.rows, studentVisibleOnly);
        return studentVisibleOnly
            ? profiles.filter((profile) => profile.templates.length > 0)
            : profiles;
    },

    getById: async (id: number): Promise<LabProfile | null> => {
        const result = await pool.query<LabProfileRow>(
            `SELECT * FROM lab_profiles WHERE id = $1`,
            [id],
        );
        const [profile] = await hydrateProfiles(result.rows, false);
        return profile ?? null;
    },

    create: async (input: CreateLabProfileDTO): Promise<LabProfile> => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query<LabProfileRow>(
                `INSERT INTO lab_profiles (name, description, allow_same_group)
                 VALUES ($1, $2, $3)
                 RETURNING *`,
                [
                    input.name,
                    input.description || null,
                    input.allow_same_group ?? true,
                ],
            );
            const profile = result.rows[0];
            await replaceDomains(client, profile.id, input.domains ?? []);
            await replaceTemplates(client, profile.id, input.template_ids ?? []);
            await client.query("COMMIT");
            return (await LabProfiles.getById(profile.id))!;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    // FOR UPDATE pins the row for the transaction. The description CASE
    // keeps "field omitted" (keep current) distinct from "field null/empty"
    // (clear it) — COALESCE alone cannot express that.
    update: async (
        id: number,
        input: UpdateLabProfileDTO,
    ): Promise<LabProfile | null> => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const current = await client.query<LabProfileRow>(
                `SELECT * FROM lab_profiles WHERE id = $1 FOR UPDATE`,
                [id],
            );
            if (current.rowCount === 0) {
                await client.query("ROLLBACK");
                return null;
            }

            await client.query(
                `UPDATE lab_profiles
                 SET name = COALESCE($2, name),
                     description = CASE WHEN $3::boolean THEN $4 ELSE description END,
                     allow_same_group = COALESCE($5, allow_same_group),
                     updated_at = NOW()
                 WHERE id = $1`,
                [
                    id,
                    input.name ?? null,
                    input.description !== undefined,
                    input.description || null,
                    input.allow_same_group ?? null,
                ],
            );
            if (input.domains !== undefined) {
                await replaceDomains(client, id, input.domains);
            }
            if (input.template_ids !== undefined) {
                await replaceTemplates(client, id, input.template_ids);
            }
            await client.query("COMMIT");
            return LabProfiles.getById(id);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    // Three-way answer so the route can pick the right status code; the
    // default profile is refused, not deleted.
    delete: async (id: number): Promise<"deleted" | "not_found" | "default"> => {
        const result = await pool.query<{ is_default: boolean }>(
            `SELECT is_default FROM lab_profiles WHERE id = $1`,
            [id],
        );
        if (result.rowCount === 0) return "not_found";
        if (result.rows[0].is_default) return "default";
        await pool.query(`DELETE FROM lab_profiles WHERE id = $1`, [id]);
        return "deleted";
    },
};
