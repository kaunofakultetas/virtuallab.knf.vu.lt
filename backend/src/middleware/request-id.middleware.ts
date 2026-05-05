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
