import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { metadata } from "@/utils/metadata";
import { initSaml } from "@/utils/saml";
import { pollMetrics } from "@/utils/metrics-poller";
import { authRouter } from "@/routes/auth.route";
import { instancesRouter } from "@/routes/instances.route";
import { templatesRouter } from "@/routes/templates.route";
import { guacamoleRouter } from "@/routes/guacamole.route";
import { metadataRouter } from "@/routes/metadata.route";
import { metricsRouter } from "@/routes/metrics.route";
import { labProfilesRouter } from "@/routes/lab-profiles.route";
import { networkRouter } from "@/routes/network.route";
import { Instances } from "@/controllers/instances.controller";
import { loggerMiddleware } from "@/middleware/logger.middleware";
import { metricsMiddleware } from "@/middleware/metrics.middleware";
import { requestIdMiddleware } from "@/middleware/request-id.middleware";
import { errorHandlerMiddleware } from "@/middleware/error-handler.middleware";

// AsyncTask, not Task. `Task` is the synchronous variant: it calls the handler
// inside a try/catch and returns immediately, so an async handler's rejection
// never reaches the error callback and escapes as an unhandled rejection --
// fatal on Node 25 -- while `preventOverrun` is silently inert because the task
// is considered finished the moment the promise is created.
import { AsyncTask, SimpleIntervalJob, ToadScheduler } from "toad-scheduler";
import { reconcileNetworkDrift } from "@/network/drift-reconciler";
import { DRIFT_RECONCILER_PRINCIPAL } from "@/network/drift-principal";
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
app.use(metricsMiddleware);
app.use(express.json());
app.use(cookieParser());

app.get("/", (req: Request, res: Response) => {
    res.status(200).send("ok");
});

app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
});

app.use("/metrics", metricsRouter);
app.use("/auth", authRouter);
app.use("/templates", templatesRouter);
app.use("/instances", instancesRouter);
app.use("/guacamole", guacamoleRouter);
app.use("/metadata", metadataRouter);
app.use("/lab-profiles", labProfilesRouter);
app.use("/network", networkRouter);

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

        await initSaml();
        logger.info(
            process.env.SAML_SP_ENTITY_ID ? "SAML SSO initialised" : "SAML SSO disabled",
        );

        // Task to update db entries of instance statuses
        const updInstanceStJob = new SimpleIntervalJob(
            { seconds: 15 },
            new AsyncTask(
                "instance status update",
                async () => {
                    try {
                        await Instances.fetchAndUpdateStatuses();
                    } catch (error) {
                        logger.error(error, "Failed to update instance statuses");
                    }
                },
                (err) =>
                    logger.error(err, "Failed to update instance statuses"),
            ),
        );
        scheduler.addSimpleIntervalJob(updInstanceStJob);

        // Refresh Prometheus gauges (Postgres counts + Proxmox + Guacamole)
        const metricsPollJob = new SimpleIntervalJob(
            { seconds: 15 },
            new AsyncTask(
                "metrics poll",
                async () => {
                    await pollMetrics();
                },
                (err) => logger.error(err, "Failed to poll metrics"),
            ),
            { preventOverrun: true },
        );
        scheduler.addSimpleIntervalJob(metricsPollJob);

        // Task to remove expired instances (instances with run_until = NULL are non-expirable)
        const removeExpiredInstancesJob = new SimpleIntervalJob(
            { minutes: 1 },
            new AsyncTask(
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

        // Re-converge network infrastructure that drifted outside a
        // provisioning or teardown request: a hand edit, a guest reboot that
        // lost a runtime-only setting, a reconciliation that failed after its
        // trigger had gone. It observes first and only repairs what actually
        // drifted, because an unconditional apply restarts Squid and dnsmasq and
        // would interrupt every session on a schedule.
        //
        // Ten minutes is a compromise: long enough that a healthy stack is only
        // being read from, short enough that drift is repaired before anybody
        // files a ticket about it. `preventOverrun` matters because a repair
        // holds the reconciliation lock for as long as the appliances take.
        const networkDriftJob = new SimpleIntervalJob(
            { minutes: 10 },
            new AsyncTask(
                "network drift reconciliation",
                async () => {
                    const report = await reconcileNetworkDrift(DRIFT_RECONCILER_PRINCIPAL);
                    if (report.drifted.length > 0 || report.failed.length > 0) {
                        logger.info(report, "Network drift reconciliation completed");
                    }
                },
                (err) => logger.error(err, "Network drift reconciliation failed"),
            ),
            { preventOverrun: true },
        );
        scheduler.addSimpleIntervalJob(networkDriftJob);

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
