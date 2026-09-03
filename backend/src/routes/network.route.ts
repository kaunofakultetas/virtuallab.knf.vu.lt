// -----------------------------------------------------------
//  [*] Routes — network: reconciliation and policy admin
//
//  Mounted at /network, admin-only throughout. The read side
//  exposes the readiness report, the rendered plan and the
//  group list; the write side is deliberately narrow — a
//  dry-run reconciliation, an on-demand drift sweep, a
//  stuck-group release, and the two policy tables (allowed
//  domains, group peerings) that only become real when the
//  next reconciliation renders them.
//
//    GET    /network/readiness                    — checks
//    GET    /network/plan                         — plan
//    GET    /network/groups                       — groups
//    POST   /network/groups/:groupId/release      — teardown
//    POST   /network/drift-reconciliations        — sweep now
//    POST   /network/reconciliation-attempts      — dry-run
//    GET    /network/reconciliation-attempts/:id  — one attempt
//    GET    /network/profiles/:profileId/domains  — list
//    POST   /network/profiles/:profileId/domains  — add
//    DELETE /network/profiles/:pid/domains/:domain — remove
//    GET    /network/peerings                     — list
//    POST   /network/peerings                     — add
//    DELETE /network/peerings/:aId/:bId           — remove
//
//  Used by:
//    - admin/Network.tsx — everything here
//    - admin/Settings.tsx — the readiness report
// -----------------------------------------------------------

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
import { reconcileNetworkDrift } from "@/network/drift-reconciler";
import { NetworkTeardownError, releaseNetworkGroup } from "@/network/teardown";
import {
    AccessClientConfigurationError,
    createAccessObserver,
} from "@/network/access-clients";
import { AccessObservationClient } from "@/network/adapters/access";
import { createGatewayObserver } from "@/network/gateway-clients";
import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { Router } from "express";
import { z } from "zod";

const router = Router();
const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/);
const profileIdSchema = z.coerce.number().int().positive();
// apply is pinned to false: only dry-run reconciliation exists over HTTP.
const dryRunSchema = z.object({
    apply: z.literal(false),
    expected_revision: revisionSchema.optional(),
    idempotency_key: z.string().min(1).max(255).optional(),
}).strict();








// -----------------------------------------------------------
// GET /network/readiness
// -----------------------------------------------------------
//
// The full readiness report — the same one that gates
// flipping settings.network.mode to "active".
//
// Used by:
//   - admin/Network.tsx, admin/Settings.tsx
// -----------------------------------------------------------

router.get("/readiness", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await getNetworkReadiness());
    } catch (error) {
        logger.error(error, "Error evaluating network readiness");
        return res.status(500).json({ error: "Failed to evaluate network readiness" });
    }
});








// -----------------------------------------------------------
// GET /network/plan
// -----------------------------------------------------------
//
// The rendered desired-state plan, straight from the DB.
//
// Used by:
//   - admin/Network.tsx — the plan panel
// -----------------------------------------------------------

router.get("/plan", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await getNetworkPlan());
    } catch (error) {
        logger.error(error, "Error generating network plan");
        return res.status(500).json({ error: "Failed to generate network plan" });
    }
});








// -----------------------------------------------------------
// GET /network/groups
// -----------------------------------------------------------
//
// Used by:
//   - admin/Network.tsx — the groups table
// -----------------------------------------------------------

router.get("/groups", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await getNetworkGroups());
    } catch (error) {
        logger.error(error, "Error listing network groups");
        return res.status(500).json({ error: "Failed to list network groups" });
    }
});








// -----------------------------------------------------------
// POST /network/groups/:groupId/release
// -----------------------------------------------------------
//
// Resumes the teardown of a network group, releasing its
// VLAN and subnet.
//
// Provisioning already releases a group when its last VM is
// deleted. This exists for the case that path leaves
// behind: a teardown that failed part-way puts the group in
// `deleting` with its allocation still reserved,
// deliberately, and nothing moves it on —
// `allocateNetworkGroup` resumes `error`, never `deleting`.
// Until somebody retries, the owner cannot create another
// VM on that profile, because `resolveNetworkAttachment`
// refuses every state but `creating` and `active`. Teardown
// is idempotent, so a retry continues from wherever the
// previous attempt stopped.
//
// Every guard stays in `releaseNetworkGroup` rather than
// being restated here: it refuses a group that still has
// instances, one whose VNet a guest still references, and
// any network mode other than `active`. This route reports
// a refusal; it never overrides one.
//
// Used by:
//   - admin/Network.tsx — the release button
//   - the equivalent CLI is `npm run release-network-group`,
//     which this deliberately does not replace — the script
//     still works when the API is down
// -----------------------------------------------------------

router.post("/groups/:groupId/release", isAuthenticated, isAdmin, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const groupId = profileIdSchema.safeParse(req.params.groupId);
    if (!groupId.success) {
        return res.status(400).json({ error: "Invalid network group ID" });
    }

    try {
        const group = (await pool.query<NetworkGroup>(
            "SELECT * FROM network_groups WHERE id = $1",
            [groupId.data],
        )).rows[0];
        if (!group) return res.status(404).json({ error: "Network group not found" });

        const outcome = await releaseNetworkGroup(group, req.user.vu_id);
        if (!outcome.released) {
            // A refusal is a legitimate answer, not a fault: the group gained a
            // VM, holds no allocation, or the mode forbids teardown. 409 keeps
            // it distinguishable from the 500 a genuine failure produces.
            return res.status(409).json({ error: outcome.reason });
        }
        logger.info(
            {
                networkGroupId: group.id,
                vlanTag: outcome.vlan_tag,
                vnetName: outcome.vnet_name,
                steps: outcome.steps,
                requestedBy: req.user.vu_id,
            },
            "Released a network group and returned its VLAN to the pool",
        );
        return res.json(outcome);
    } catch (error) {
        if (error instanceof NetworkTeardownError) {
            // The group stays in `deleting` with its allocation reserved, which
            // is what makes an identical request a valid retry once the cause is
            // fixed. `step` tells the operator where it stopped.
            logger.error(
                { err: error, networkGroupId: groupId.data },
                "Network group release failed; the group remains in `deleting`",
            );
            return res.status(409).json({ error: error.message, step: error.step });
        }
        logger.error(error, "Error releasing a network group");
        return res.status(500).json({ error: "Failed to release the network group" });
    }
});








// -----------------------------------------------------------
// POST /network/drift-reconciliations
// -----------------------------------------------------------
//
// Runs the drift sweep now instead of waiting for the
// ten-minute timer.
//
// Some changes are written to the database and become real
// only when something renders them onto the infrastructure.
// A group peering is the clearest case: it has to reach the
// Gateway's forward path *and* every target VM's firewall,
// and nothing but the drift sweep re-applies the second
// one. Waiting up to ten minutes is fine for a background
// correction and useless when a lab starts in five, which
// is what this is for.
//
// This is not the `apply: true` that
// `/reconciliation-attempts` refuses, and the distinction
// is the point. That would be an unconditional apply of the
// whole plan; this is the same observe-then-repair pass the
// scheduler already runs unattended, so it touches only
// what genuinely drifted and restarts Squid and dnsmasq
// only when the Gateway is actually wrong. It opens no
// capability the stack did not already exercise on its own
// — it only changes when.
//
// `requestedBy` is the calling admin rather than
// `DRIFT_RECONCILER_PRINCIPAL`: the attempt log is an audit
// trail, and a person did ask for this one.
//
// The report is always returned with 200, including when
// the pass declined to run. `ran: false` with a reason, and
// `failed` entries alongside `repaired` ones, are results
// worth rendering — collapsing them into an HTTP status
// would throw away the half that says what happened.
//
// Used by:
//   - admin/Network.tsx — the "reconcile now" button
// -----------------------------------------------------------

router.post("/drift-reconciliations", isAuthenticated, isAdmin, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    try {
        return res.json(await reconcileNetworkDrift(req.user.vu_id));
    } catch (error) {
        logger.error(error, "Error running drift reconciliation");
        return res.status(500).json({ error: "Failed to run drift reconciliation" });
    }
});








// -----------------------------------------------------------
// POST /network/reconciliation-attempts
// -----------------------------------------------------------
//
// Plans a dry-run reconciliation: observe everything,
// compute the diff, persist the attempt — apply is refused
// by schema. The Access observer is mandatory (503 when not
// configured); the Gateway observer is optional and its
// checks are simply omitted when absent.
//
// Used by:
//   - admin/Network.tsx — the dry-run button
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// GET /network/reconciliation-attempts/:id
// -----------------------------------------------------------
//
// Used by:
//   - admin/Network.tsx — the attempt detail view
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// Policy administration — allowed domains and peerings
// -----------------------------------------------------------
//
// These are the only two inputs to network desired state
// that are not derived from something else, and they were
// previously editable only in SQL. Writing here changes the
// database and nothing more: the change becomes real when
// the next reconciliation renders it, on the same path
// provisioning and teardown use. That keeps the apply
// surface exactly where it already is.
// -----------------------------------------------------------

const peeringBodySchema = z.object({
    group_a_id: z.number().int().positive(),
    group_b_id: z.number().int().positive(),
}).strict();








// -----------------------------------------------------------
// GET /network/profiles/:profileId/domains
// -----------------------------------------------------------
//
// Used by:
//   - admin/Network.tsx — the domain list per profile
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// POST /network/profiles/:profileId/domains
// -----------------------------------------------------------
//
// Used by:
//   - admin/Network.tsx — the add-domain form
// -----------------------------------------------------------

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
        // 23503 = foreign-key violation — the profile does not exist.
        if ((error as { code?: string }).code === "23503") {
            return res.status(404).json({ error: "Lab profile not found" });
        }
        logger.error(error, "Error adding an allowed web domain");
        return res.status(500).json({ error: "Failed to add the allowed web domain" });
    }
});








// -----------------------------------------------------------
// DELETE /network/profiles/:profileId/domains/:domain
// -----------------------------------------------------------
//
// Used by:
//   - admin/Network.tsx — the domain delete button
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// GET /network/peerings
// -----------------------------------------------------------
//
// Used by:
//   - admin/Network.tsx — the peerings table
// -----------------------------------------------------------

router.get("/peerings", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        return res.json(await listGroupPeerings());
    } catch (error) {
        logger.error(error, "Error listing group peerings");
        return res.status(500).json({ error: "Failed to list group peerings" });
    }
});








// -----------------------------------------------------------
// POST /network/peerings
// -----------------------------------------------------------
//
// Used by:
//   - admin/Network.tsx — the add-peering form
// -----------------------------------------------------------

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
        // 23503 = foreign-key violation — a named group does not exist.
        if ((error as { code?: string }).code === "23503") {
            return res.status(404).json({ error: "One or both network groups do not exist" });
        }
        logger.error(error, "Error adding a group peering");
        return res.status(500).json({ error: "Failed to add the group peering" });
    }
});








// -----------------------------------------------------------
// DELETE /network/peerings/:groupAId/:groupBId
// -----------------------------------------------------------
//
// Used by:
//   - admin/Network.tsx — the peering delete button
// -----------------------------------------------------------

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
