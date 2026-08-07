import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { getNetworkPlan } from "@/network/desired-state";
import { getNetworkGroups } from "@/network/groups";
import {
    InfrastructureReconciler,
    ReconciliationRevisionError,
} from "@/network/infrastructure-reconciler";
import {
    ReconciliationAttemptRepository,
    ReconciliationLockedError,
} from "@/network/reconciliation-attempts";
import { getNetworkReadiness } from "@/network/readiness";
import { ProxmoxClient } from "@/proxmox/api";
import { RestrictedSshAccessObservationClient } from "@/network/adapters/access";
import { RestrictedSshTransport } from "@/network/adapters/restricted-ssh";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { Router } from "express";
import { z } from "zod";

const router = Router();
const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/);
const dryRunSchema = z.object({
    apply: z.literal(false),
    expected_revision: revisionSchema.optional(),
    idempotency_key: z.string().min(1).max(255).optional(),
}).strict();
const accessObserverConfigSchema = z.object({
    ACCESS_OBSERVER_HOST: z.string().min(1),
    ACCESS_OBSERVER_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    ACCESS_OBSERVER_HOST_KEY_ALIAS: z.string().min(1).optional(),
    ACCESS_OBSERVER_USER: z.string().min(1),
    ACCESS_OBSERVER_IDENTITY_FILE: z.string().startsWith("/"),
    ACCESS_OBSERVER_KNOWN_HOSTS_FILE: z.string().startsWith("/"),
    ACCESS_OBSERVER_COMMAND: z.string().min(1).default("virtual-lab-access-observe"),
});

router.get("/readiness", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await getNetworkReadiness());
    } catch (error) {
        logger.error(error, "Error evaluating network readiness");
        return res.status(500).json({ error: "Failed to evaluate network readiness" });
    }
});

router.get("/plan", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await getNetworkPlan());
    } catch (error) {
        logger.error(error, "Error generating network plan");
        return res.status(500).json({ error: "Failed to generate network plan" });
    }
});

router.get("/groups", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await getNetworkGroups());
    } catch (error) {
        logger.error(error, "Error listing network groups");
        return res.status(500).json({ error: "Failed to list network groups" });
    }
});

router.post("/reconciliation-attempts", isAuthenticated, isAdmin, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const parsed = dryRunSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({
            error: "Only validated dry-run reconciliation is currently available",
            details: parsed.error.issues,
        });
    }

    const observerConfig = accessObserverConfigSchema.safeParse(process.env);
    if (!observerConfig.success) {
        return res.status(503).json({ error: "Access observation is not configured" });
    }

    const client = new ProxmoxClient({
        baseUrl: process.env.PROXMOX_BASE_URL!,
        nodeName: process.env.PROXMOX_NODE_NAME!,
        authToken: process.env.PROXMOX_AUTH_TOKEN!,
        rejectUnauthorized: process.env.PROXMOX_TLS_INSECURE !== "true",
    });
    try {
        const attempt = await new InfrastructureReconciler({
            database: pool,
            proxmox: client,
            access: new RestrictedSshAccessObservationClient(new RestrictedSshTransport({
                host: observerConfig.data.ACCESS_OBSERVER_HOST,
                port: observerConfig.data.ACCESS_OBSERVER_PORT,
                hostKeyAlias: observerConfig.data.ACCESS_OBSERVER_HOST_KEY_ALIAS,
                user: observerConfig.data.ACCESS_OBSERVER_USER,
                identityFile: observerConfig.data.ACCESS_OBSERVER_IDENTITY_FILE,
                knownHostsFile: observerConfig.data.ACCESS_OBSERVER_KNOWN_HOSTS_FILE,
                remoteCommand: observerConfig.data.ACCESS_OBSERVER_COMMAND,
            })),
        }).dryRun({
            requestedBy: req.user.vu_id,
            expectedRevision: parsed.data.expected_revision,
            idempotencyKey: parsed.data.idempotency_key,
        });
        res.location(`/network/reconciliation-attempts/${attempt.id}`);
        return res.status(202).json(attempt);
    } catch (error) {
        if (error instanceof ReconciliationLockedError || error instanceof ReconciliationRevisionError) {
            return res.status(409).json({ error: error.message });
        }
        logger.error(error, "Error planning network reconciliation");
        return res.status(500).json({ error: "Failed to plan network reconciliation" });
    } finally {
        await client.close();
    }
});

router.get("/reconciliation-attempts/:id", isAuthenticated, isAdmin, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!/^\d+$/.test(id)) {
        return res.status(400).json({ error: "Reconciliation attempt ID must be numeric" });
    }
    try {
        const attempt = await new ReconciliationAttemptRepository().getById(id);
        if (!attempt) return res.status(404).json({ error: "Reconciliation attempt not found" });
        return res.json(attempt);
    } catch (error) {
        logger.error(error, "Error reading network reconciliation attempt");
        return res.status(500).json({ error: "Failed to read network reconciliation attempt" });
    }
});

export { router as networkRouter };