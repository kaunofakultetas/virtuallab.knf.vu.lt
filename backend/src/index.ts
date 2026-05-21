import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { metadata } from "@/utils/metadata";
import { authRouter } from "@/routes/auth.route";
import { instancesRouter } from "@/routes/instances.route";
import { templatesRouter } from "@/routes/templates.route";
import { guacamoleRouter } from "@/routes/guacamole.route";
import { metadataRouter } from "@/routes/metadata.route";
import { Instances } from "@/controllers/instances.controller";
import { loggerMiddleware } from "@/middleware/logger.middleware";
import { requestIdMiddleware } from "@/middleware/request-id.middleware";
import { errorHandlerMiddleware } from "@/middleware/error-handler.middleware";

import { SimpleIntervalJob, Task, ToadScheduler } from "toad-scheduler";
import express, { Application, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { Server } from "http";
import path from "path";
import fs from "fs";

const app: Application = express();
const port: number = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const scheduler = new ToadScheduler();

app.set("trust proxy", 1);
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
app.use("/guacamole", guacamoleRouter);
app.use("/metadata", metadataRouter);

app.use(errorHandlerMiddleware);

let server: Server | undefined;
let shuttingDown = false;

const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown signal received");

    const forceTimeout = setTimeout(() => {
        logger.error("forced shutdown after 10s");
        process.exit(1);
    }, 10_000);
    forceTimeout.unref();

    try {
        // 1. Stop accepting new HTTP connections, wait for in-flight to finish
        if (server) {
            await new Promise<void>((resolve, reject) => {
                server!.close((err) => (err ? reject(err) : resolve()));
            });
            logger.info("http server closed");
        }

        // 2. Stop the scheduler; an in-flight task is given a moment to finish
        scheduler.stop();
        logger.info("scheduler stopped");

        // 3. Close the DB pool last — after HTTP and scheduler are done with it
        await pool.end();
        logger.info("db pool closed");

        clearTimeout(forceTimeout);
        process.exit(0);
    } catch (err) {
        logger.error(err, "error during shutdown");
        process.exit(1);
    }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function bootstrap() {
    try {
        const schemaPath = path.join(__dirname, "..", "schema.sql");
        const schema = fs.readFileSync(schemaPath, "utf-8");
        await pool.query(schema);
        await metadata.initDefaults();
        logger.info("Database schema is up to date");

        // Task to update db entries of instance statuses
        const updInstanceStJob = new SimpleIntervalJob(
            { seconds: 15 },
            new Task(
                "instance status update",
                async () => {
                    await Instances.fetchAndUpdateStatuses();
                },
                (err) =>
                    logger.error(err, "Failed to update instance statuses"),
            ),
        );
        scheduler.addSimpleIntervalJob(updInstanceStJob);

        // Task to remove expired instances (instances with run_until = NULL are non-expirable)
        const removeExpiredInstancesJob = new SimpleIntervalJob(
            { minutes: 1 },
            new Task(
                "remove expired instances",
                async () => {
                    const removed = await Instances.removeExpiredInstances();
                    if (removed > 0) {
                        logger.info({ removed }, "Removed expired instances");
                    }
                },
                (err) =>
                    logger.error(err, "Failed to remove expired instances"),
            ),
        );
        scheduler.addSimpleIntervalJob(removeExpiredInstancesJob);

        server = app.listen(port, "0.0.0.0", () => {
            logger.info(`Server is running on http://0.0.0.0:${port}`);
        });
    } catch (err) {
        logger.error(err, "Error setting up database schema");
        scheduler.stop();
        await pool.end().catch(() => {});
        process.exit(1);
    }
}

void bootstrap();
