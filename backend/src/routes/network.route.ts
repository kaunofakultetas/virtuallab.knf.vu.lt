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
import {
    addAllowedDomain,
    addGroupPeering,
    allowedDomainSchema,
    listAllowedDomains,
    listGroupPeerings,
    NetworkPolicyError,
    removeAllowedDomain,
    removeGroupPeering,
} from "@/network/policy";
import { createNetworkProxmoxObserver } from "@/network/proxmox-clients";
import {
    AccessClientConfigurationError,
    createAccessObserver,
} from "@/network/access-clients";
import { AccessObservationClient } from "@/network/adapters/access";
import { createGatewayObserver } from "@/network/gateway-clients";
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

    let accessObserver: AccessObservationClient;
    try {
        accessObserver = createAccessObserver();
    } catch (error) {
        if (!(error instanceof AccessClientConfigurationError)) throw error;
        return res.status(503).json({ error: "Access observation is not configured" });
    }

    // Optional: without a provisioned observer principal the dry-run simply
    // reports no Gateway checks rather than failing the whole route.
    const gatewayObserver = createGatewayObserver();
    if (!gatewayObserver) {
        logger.warn("Gateway observation is not configured; its checks will be omitted");
    }

    let client;
    try {
        client = createNetworkProxmoxObserver();
        const attempt = await new InfrastructureReconciler({
            database: pool,
            proxmox: client,
            gateway: gatewayObserver ?? undefined,
            access: accessObserver,
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
        await client?.close();
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

/**
 * Policy administration.
 *
 * These are the only two inputs to network desired state that are not derived
 * from something else, and they were previously editable only in SQL. Writing
 * here changes the database and nothing more: the change becomes real when the
 * next reconciliation renders it, on the same path provisioning and teardown
 * use. That keeps the apply surface exactly where it already is.
 */
const profileIdSchema = z.coerce.number().int().positive();
const peeringBodySchema = z.object({
    group_a_id: z.number().int().positive(),
    group_b_id: z.number().int().positive(),
}).strict();

router.get("/profiles/:profileId/domains", isAuthenticated, isAdmin, async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile ID" });
    try {
        return res.json(await listAllowedDomains(profileId.data));
    } catch (error) {
        logger.error(error, "Error listing allowed web domains");
        return res.status(500).json({ error: "Failed to list allowed web domains" });
    }
});

router.post("/profiles/:profileId/domains", isAuthenticated, isAdmin, async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile ID" });
    const parsed = allowedDomainSchema.safeParse(req.body);
    if (!parsed.success) {
        // Rejected here rather than on the Gateway: a scheme, port or wildcard
        // would either widen the allowlist or fail to parse after the apply,
        // where it is expensive to discover.
        return res.status(400).json({
            error: "Invalid domain",
            details: parsed.error.issues,
        });
    }
    try {
        return res.status(201).json(await addAllowedDomain(profileId.data, parsed.data));
    } catch (error) {
        if ((error as { code?: string }).code === "23503") {
            return res.status(404).json({ error: "Lab profile not found" });
        }
        logger.error(error, "Error adding an allowed web domain");
        return res.status(500).json({ error: "Failed to add the allowed web domain" });
    }
});

router.delete("/profiles/:profileId/domains/:domain", isAuthenticated, isAdmin, async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile ID" });
    const domain = Array.isArray(req.params.domain) ? req.params.domain[0] : req.params.domain;
    try {
        const removed = await removeAllowedDomain(profileId.data, String(domain));
        if (!removed) return res.status(404).json({ error: "Allowed web domain not found" });
        return res.status(204).end();
    } catch (error) {
        logger.error(error, "Error removing an allowed web domain");
        return res.status(500).json({ error: "Failed to remove the allowed web domain" });
    }
});

router.get("/peerings", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await listGroupPeerings());
    } catch (error) {
        logger.error(error, "Error listing group peerings");
        return res.status(500).json({ error: "Failed to list group peerings" });
    }
});

router.post("/peerings", isAuthenticated, isAdmin, async (req, res) => {
    const parsed = peeringBodySchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid peering", details: parsed.error.issues });
    }
    try {
        return res.status(201).json(
            await addGroupPeering(parsed.data.group_a_id, parsed.data.group_b_id),
        );
    } catch (error) {
        if (error instanceof NetworkPolicyError) {
            return res.status(400).json({ error: error.message });
        }
        if ((error as { code?: string }).code === "23503") {
            return res.status(404).json({ error: "One or both network groups do not exist" });
        }
        logger.error(error, "Error adding a group peering");
        return res.status(500).json({ error: "Failed to add the group peering" });
    }
});

router.delete("/peerings/:groupAId/:groupBId", isAuthenticated, isAdmin, async (req, res) => {
    const a = profileIdSchema.safeParse(req.params.groupAId);
    const b = profileIdSchema.safeParse(req.params.groupBId);
    if (!a.success || !b.success) {
        return res.status(400).json({ error: "Invalid network group ID" });
    }
    try {
        const removed = await removeGroupPeering(a.data, b.data);
        if (!removed) return res.status(404).json({ error: "Group peering not found" });
        return res.status(204).end();
    } catch (error) {
        if (error instanceof NetworkPolicyError) {
            return res.status(400).json({ error: error.message });
        }
        logger.error(error, "Error removing a group peering");
        return res.status(500).json({ error: "Failed to remove the group peering" });
    }
});

export { router as networkRouter };