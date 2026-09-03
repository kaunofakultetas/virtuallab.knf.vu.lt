// -----------------------------------------------------------
//  [*] Utils — normalising template API responses
//
//  The template endpoints have answered in more than one
//  shape over time (bare array, { templates }, bare object,
//  { template }), and visible_to_students has arrived as
//  boolean, number and string. These helpers absorb all of
//  it so the pages only ever see a Template.
//
//  Used by:
//    - router.tsx — the two template loaders
//    - pages/admin/Templates.tsx, TemplateDetails.tsx
// -----------------------------------------------------------

import type { Template } from "@/types/templates";
export { getErrorMessage } from "@/utils/errors";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;


// boolean | 1/0 | "true"/"false"/"1"/"0" → boolean; anything else undefined.
const normalizeVisibility = (value: unknown): boolean | undefined => {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value === 1;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1") {
            return true;
        }
        if (normalized === "false" || normalized === "0") {
            return false;
        }
    }
    return undefined;
};


const normalizeTemplate = (template: Template): Template => {
    const rawVisibility = (template as unknown as Record<string, unknown>)
        .visible_to_students;
    const normalizedVisibility = normalizeVisibility(rawVisibility);
    if (normalizedVisibility === undefined) {
        return template;
    }
    return {
        ...template,
        visible_to_students: normalizedVisibility,
    };
};








// -----------------------------------------------------------
// extractTemplates
// -----------------------------------------------------------
//
// Array or { templates: [...] } → normalised list; null
// means "unrecognised response", which the loaders turn
// into a 500.
//
// Used by:
//   - router.tsx — templatesLoader
// -----------------------------------------------------------

export const extractTemplates = (data: unknown): Template[] | null => {
    if (Array.isArray(data)) {
        return (data as Template[]).map(normalizeTemplate);
    }
    if (isRecord(data) && Array.isArray(data.templates)) {
        return (data.templates as Template[]).map(normalizeTemplate);
    }
    return null;
};








// -----------------------------------------------------------
// extractTemplate
// -----------------------------------------------------------
//
// { template } or a bare object → one normalised template.
//
// Used by:
//   - router.tsx — templateDetailsLoader
//   - pages/admin/TemplateDetails.tsx
// -----------------------------------------------------------

export const extractTemplate = (data: unknown): Template | null => {
    if (Array.isArray(data)) {
        return null;
    }
    if (isRecord(data) && isRecord(data.template)) {
        return normalizeTemplate(data.template as unknown as Template);
    }
    if (isRecord(data)) {
        return normalizeTemplate(data as unknown as Template);
    }
    return null;
};








// -----------------------------------------------------------
// getResponseMessage
// -----------------------------------------------------------
//
// Used by:
//   - pages/admin/Templates.tsx — success toasts
// -----------------------------------------------------------

export const getResponseMessage = (data: unknown, fallback: string) => {
    if (isRecord(data)) {
        if (typeof data.message === "string") {
            return data.message;
        }
        if (typeof data.status === "string") {
            return data.status;
        }
    }
    return fallback;
};
