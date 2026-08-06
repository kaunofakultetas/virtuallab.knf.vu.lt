import z from "zod";

const domainNamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const allowedWebDomainSchema = z.object({
    domain: z
        .string()
        .trim()
        .toLowerCase()
        .refine((domain) => domainNamePattern.test(domain), {
            message: "domain must be a hostname without a scheme, path, port, or trailing dot",
        }),
    include_subdomains: z.boolean().default(true),
});

const profileFields = {
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(5000).optional(),
    allow_same_group: z.boolean().optional().default(true),
    domains: z
        .array(allowedWebDomainSchema)
        .max(500)
        .refine(
            (domains) =>
                new Set(domains.map(({ domain }) => domain)).size ===
                domains.length,
            { message: "domains must be unique" },
        )
        .optional()
        .default([]),
    template_ids: z
        .array(z.number().int().positive())
        .max(500)
        .refine((ids) => new Set(ids).size === ids.length, {
            message: "template_ids must be unique",
        })
        .optional()
        .default([]),
};

export const createLabProfileSchema = z.object(profileFields);

export const updateLabProfileSchema = z
    .object({
        name: profileFields.name.optional(),
        description: profileFields.description,
        allow_same_group: z.boolean().optional(),
        domains: profileFields.domains.optional(),
        template_ids: profileFields.template_ids.optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: "At least one field must be provided for update",
    });

export const labProfileParamsSchema = z.object({
    id: z.string().regex(/^\d+$/, "id must be a positive integer"),
});