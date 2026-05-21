import { RequestHandler } from "express";
import z from "zod";

type ValidationSchemas = {
    body?: z.ZodType;
    params?: z.ZodType;
    query?: z.ZodType;
};

export const validateRequest = ({
    body,
    params,
    query,
}: ValidationSchemas): RequestHandler => {
    return (req, res, next) => {
        const errors: Record<string, unknown> = {};

        if (body) {
            const parsedBody = body.safeParse(req.body);
            if (!parsedBody.success) {
                errors.body = parsedBody.error.flatten();
            } else {
                req.body = parsedBody.data;
            }
        }

        if (params) {
            const parsedParams = params.safeParse(req.params);
            if (!parsedParams.success) {
                errors.params = parsedParams.error.flatten();
            } else {
                req.params = parsedParams.data as typeof req.params;
            }
        }

        if (query) {
            const parsedQuery = query.safeParse(req.query);
            if (!parsedQuery.success) {
                errors.query = parsedQuery.error.flatten();
            } else {
                req.query = parsedQuery.data as typeof req.query;
            }
        }

        if (Object.keys(errors).length > 0) {
            return res.status(400).json({
                error: "Validation failed",
                details: errors,
            });
        }

        next();
    };
};
