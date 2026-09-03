// -----------------------------------------------------------
//  [*] Middleware — request ID propagation
//
//  Takes the caller's x-request-id when one is present (the
//  first non-empty value if the header repeats), mints a
//  UUID otherwise, and puts it on req.id and the response
//  header — so one ID follows a request through the access
//  log, the error handler and the client's own logs.
//
//  Used by:
//    - index.ts — registered first, before any logging
// -----------------------------------------------------------

import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";

type RequestWithId = Request & {
    id?: string;
};


export const requestIdMiddleware = (
    req: RequestWithId,
    res: Response,
    next: NextFunction,
) => {
    const headerValue = req.headers["x-request-id"];
    const requestId =
        typeof headerValue === "string" && headerValue.trim() !== ""
            ? headerValue
            : Array.isArray(headerValue) &&
                headerValue.length > 0 &&
                headerValue[0].trim() !== ""
              ? headerValue[0]
              : randomUUID();

    req.id = requestId;
    res.setHeader("x-request-id", requestId);

    next();
};
