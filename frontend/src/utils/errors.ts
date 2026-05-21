import axios from "axios";

interface ZodSection {
    formErrors?: string[];
    fieldErrors?: Record<string, string[]>;
}

function extractValidationMessages(details: Record<string, unknown>): string {
    const messages: string[] = [];
    for (const section of ["body", "params", "query"]) {
        const sec = details[section] as ZodSection | undefined;
        if (!sec) continue;
        for (const msg of sec.formErrors ?? []) messages.push(msg);
        for (const [field, errs] of Object.entries(sec.fieldErrors ?? {})) {
            messages.push(`${field}: ${errs.join(", ")}`);
        }
    }
    return messages.join("; ") || "Validation failed";
}

export function getErrorMessage(err: unknown, fallback: string): string {
    if (axios.isAxiosError(err)) {
        const data = err.response?.data;
        if (
            data?.error === "Validation failed" &&
            data.details !== null &&
            typeof data.details === "object"
        ) {
            return extractValidationMessages(
                data.details as Record<string, unknown>,
            );
        }
        return data?.error ?? data?.message ?? err.message ?? fallback;
    }
    if (err instanceof Error) return err.message;
    return fallback;
}
