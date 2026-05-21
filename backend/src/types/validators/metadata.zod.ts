import z from "zod";

export const metadataKeyParamSchema = z.object({
    key: z.string().min(1),
});

export const updateMetadataSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
