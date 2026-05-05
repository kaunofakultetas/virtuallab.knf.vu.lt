import express, { Application, Request, Response } from "express";
import cookieParser from "cookie-parser";

import { pool } from "@/utils/db";
import { errorHandlerMiddleware } from "@/middleware/error-handler.middleware";
import { logger } from "@/utils/logger";
import { loggerMiddleware } from "@/middleware/logger.middleware";
import { requestIdMiddleware } from "@/middleware/request-id.middleware";
import { templatesRouter } from "@/routes/templates.route";
import { authRouter } from "@/routes/auth.route";

import fs from "fs";
import path from "path";

const app: Application = express();
const port: number = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.use(requestIdMiddleware);
app.use(loggerMiddleware);
app.use(express.json());
app.use(cookieParser());

app.get("/", (req: Request, res: Response) => {
  res.status(200).send();
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.use("/templates", templatesRouter);
app.use("/auth", authRouter);

app.use(errorHandlerMiddleware);

async function bootstrap() {
  try {
    const schemaPath = path.join(__dirname, "..", "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf-8");

    await pool.query(schema);
    logger.info("Database schema is up to date");

    app.listen(port, "0.0.0.0", () => {
      logger.info(`Server is running on http://0.0.0.0:${port}`);
    });
  } catch (err) {
    logger.error(err, "Error setting up database schema");
    process.exit(1);
  }
}

void bootstrap();
