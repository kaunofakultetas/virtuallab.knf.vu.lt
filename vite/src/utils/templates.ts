import type { Template } from "@/types/templates";
export { getErrorMessage } from "@/utils/errors";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

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

export const extractTemplates = (data: unknown): Template[] | null => {
    if (Array.isArray(data)) {
        return (data as Template[]).map(normalizeTemplate);
    }
    if (isRecord(data) && Array.isArray(data.templates)) {
        return (data.templates as Template[]).map(normalizeTemplate);
    }
    return null;
};

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
