import express, { Application, Request, Response } from "express";
import cookieParser from "cookie-parser";

import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { authRouter } from "@/routes/auth.route";
import { templatesRouter } from "@/routes/templates.route";
import { loggerMiddleware } from "@/middleware/logger.middleware";
import { requestIdMiddleware } from "@/middleware/request-id.middleware";
import { errorHandlerMiddleware } from "@/middleware/error-handler.middleware";

import fs from "fs";
import path from "path";
import { instancesRouter } from "./routes/instances.route";
import { guacamole } from "./guacamole";

const app: Application = express();
const port: number = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.use(requestIdMiddleware);
app.use(loggerMiddleware);
app.use(express.json());
app.use(cookieParser());

app.get("/", (req: Request, res: Response) => {
    res.status(200).send("ok");
});

app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
});

app.use("/auth", authRouter);
app.use("/templates", templatesRouter);
app.use("/instances", instancesRouter);

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
