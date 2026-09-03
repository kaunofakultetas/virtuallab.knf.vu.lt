// -----------------------------------------------------------
//  [*] Middleware — the terminal error handler
//
//  Express's last stop: logs the full error with request
//  context (URL, method, params, request ID) and answers
//  with the error's own status when it carries one, 500
//  otherwise. The body is always the generic string —
//  internals never leak to the client; the details live in
//  the log line, findable by requestId.
//
//  Used by:
//    - index.ts — registered after every route
// -----------------------------------------------------------

import { ErrorRequestHandler, Request } from "express";
import { logger } from "@/utils/logger";

type RequestWithId = Request & {
    id?: string;
};

type HttpError = Error & {
    status?: number;
};


export const errorHandlerMiddleware: ErrorRequestHandler = (
    err: HttpError,
    req,
    res,
    _next,
) => {
    const request = req as RequestWithId;
    const status = err.status ?? 500;

    logger.error(
        {
            err,
            url: request.originalUrl || request.url,
            method: request.method,
            params: request.params,
            requestId:
                request.id ??
                (typeof request.headers["x-request-id"] === "string"
                    ? request.headers["x-request-id"]
                    : undefined),
        },
        "request error",
    );

    res.status(status).json({ error: "Internal Server Error" });
};
