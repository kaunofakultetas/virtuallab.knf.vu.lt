// -----------------------------------------------------------
//  [*] Validators — metadata request schemas
//
//  Values are limited to JSON scalars here even though the
//  store itself takes arrays/objects — the admin UI only
//  edits scalar settings.
//
//  Used by:
//    - metadata.route.ts
// -----------------------------------------------------------

import z from "zod";

export const metadataKeyParamSchema = z.object({
    key: z.string().min(1),
});

export const updateMetadataSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
