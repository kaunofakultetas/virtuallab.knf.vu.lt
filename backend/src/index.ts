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
import { SimpleIntervalJob, Task, ToadScheduler } from "toad-scheduler";
import { Instances } from "./controllers/instances.controller";

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

app.use(errorHandlerMiddleware);

async function bootstrap() {
    try {
        const schemaPath = path.join(__dirname, "..", "schema.sql");
        const schema = fs.readFileSync(schemaPath, "utf-8");

        await pool.query(schema);
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

        app.listen(port, "0.0.0.0", () => {
            logger.info(`Server is running on http://0.0.0.0:${port}`);
        });
    } catch (err) {
        logger.error(err, "Error setting up database schema");
        scheduler.stop();
        process.exit(1);
    }
}

void bootstrap();

// TODO:
// - Create an in-db stored config that can be edited at runtime thru web
// - Limit student allowed concurrent created vms
// - Add route to delete specific vm
// - Auto-removal of expired vms
// - Admin route to make vms not expireable / make em expireable again
// - Add validation to all routes
