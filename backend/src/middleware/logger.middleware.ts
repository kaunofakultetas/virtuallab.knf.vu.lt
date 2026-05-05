import { NextFunction, Request, Response } from "express";
import { logger } from "@/utils/logger";

type RequestWithId = Request & {
  id?: string;
};

export const loggerMiddleware = (
  req: RequestWithId,
  res: Response,
  next: NextFunction,
) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;

    logger.info(
      {
        method: req.method,
        url: req.originalUrl || req.url,
        status: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip,
        requestId:
          req.id ??
          (typeof req.headers["x-request-id"] === "string"
            ? req.headers["x-request-id"]
            : undefined),
      },
      "request completed",
    );
  });

  next();
};
