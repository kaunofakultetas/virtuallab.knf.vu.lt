// -----------------------------------------------------------
//  [*] Routes — instances: the student-facing VM lifecycle
//
//  Mounted at /instances. Access control is per-instance:
//  owner or admin, checked through Instances.hasAccessTo on
//  every ID route. The big ones are POST / (create with
//  network provisioning around it) and POST /:id/session
//  (start the VM, then build whichever connection the
//  template calls for).
//
//  The five state-changing sub-routes are POST, not GET. They
//  were GET, which made them reachable from a bare <img> tag —
//  and the VM web-UI proxy serves student-authored content
//  from the same SITE as this API, so SameSite=Strict did not
//  stop it. See same-origin.middleware.ts, which is the actual
//  defence; the verbs are defence in depth.
//
//    GET    /instances                    — own instances
//    GET    /instances/all                — all (admin)
//    GET    /instances/all/running        — Proxmox view (admin)
//    ALL    /instances/proxy-auth         — Caddy forward-auth
//    GET    /instances/:instanceId        — one instance
//    POST   /instances                    — create
//    DELETE /instances/:instanceId        — delete
//    PATCH  /instances/:instanceId/expirable — admin toggle
//    POST   /instances/:instanceId/start  — start VM
//    POST   /instances/:instanceId/stop   — stop VM
//    POST   /instances/:instanceId/reboot — reboot VM
//    POST   /instances/:instanceId/session — connection URL
//    POST   /instances/:instanceId/renew  — extend runtime
//    GET    /instances/:instanceId/ip     — guest IPv4 list
// -----------------------------------------------------------

import {
    Instances,
    InstanceQuotaExceededError,
} from "@/controllers/instances.controller";
import { LabProfiles } from "@/controllers/lab-profiles.controller";
import { Templates } from "@/controllers/templates.controller";
import { Users } from "@/controllers/users.controller";
import { guacamole } from "@/guacamole";
import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { validateRequest } from "@/middleware/zod-validation.middleware";
import { proxmox } from "@/proxmox";
import { CreateInstanceDTO } from "@/types/instances";
import { GuacamoleConnectionConfig, SshConnectionConfig } from "@/types/templates";
import {
    createInstanceSchema,
    instanceIdParamSchema,
    setExpirableSchema,
} from "@/types/validators/instances.zod";
import { logger } from "@/utils/logger";
import { metadata } from "@/utils/metadata";
import { getOrCreatePlannedGroup, markNetworkGroupActive } from "@/network/groups";
import {
    compensateNetworkAttachment,
    resolveNetworkAttachment,
} from "@/network/attachment";
import { getNetworkPlan } from "@/network/desired-state";
import { ensureNetworkGroupInfrastructure } from "@/network/provisioning-network";
import { ensureInstanceFirewall } from "@/network/provisioning-firewall";
import { releaseNetworkGroupAfterInstance } from "@/network/provisioning-teardown";
import { getNetworkMode } from "@/network/mode";
import { randomBytes } from "crypto";
import { Router } from "express";

const router = Router();

// Short-lived cache of resolved VM IPs, keyed by instance id. The web-UI proxy
// forward-auth fires once per proxied asset, so we avoid hitting Proxmox each time.
const webProxyIpCache = new Map<number, { ip: string; exp: number }>();
const WEB_PROXY_IP_TTL_MS = 30_000;








// -----------------------------------------------------------
// ensureGuacamoleAccount
// -----------------------------------------------------------
//
// Returns the secret this backend uses to log in AS the given
// user, provisioning the Guacamole account if it is missing.
//
// The account's password used to be the user's own vu_id, so
// anyone who could reach Guacamole could sign in as any
// student whose number they knew. It is now a random secret
// held only here.
//
// Rotation is delete-and-recreate because GuacamoleClient has
// no password-change method. That is safe: connection grants
// are re-checked and re-added per session by both callers, so
// recreating the account loses nothing.
//
// Used by:
//   - POST /instances/:instanceId/session — both branches
// -----------------------------------------------------------

async function ensureGuacamoleAccount(userId: string): Promise<string> {
    const [storedSecret, guacUser] = await Promise.all([
        Users.getGuacPassword(userId),
        guacamole.getUser(userId),
    ]);

    // Both present and consistent — nothing to do.
    if (storedSecret && guacUser) return storedSecret;

    const secret = randomBytes(24).toString("base64url");

    // A user with no stored secret still has the old vu_id-derived password on
    // the Guacamole side, so the account has to go before it can be remade.
    // deleteUser swallows 404, so this is safe when the account is simply gone.
    if (guacUser) {
        await guacamole.deleteUser(userId);
    }

    await guacamole.createUser(userId, secret);
    await Users.setGuacPassword(userId, secret);

    logger.info({ userId }, "Provisioned a Guacamole account with a random password");

    return secret;
}








// -----------------------------------------------------------
// GET /instances
// -----------------------------------------------------------
//
// The current user's instances, with their network-group
// and profile columns joined in.
//
// Used by:
//   - Index.tsx, Instances.tsx — the student dashboard
// -----------------------------------------------------------

router.get("/", isAuthenticated, (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    Instances.getAllForUser(req.user.vu_id)
        .then((instances) => res.json(instances))
        .catch((err) => {
            logger.error(
                { err, vu_id: req.user?.vu_id },
                "Error getting instances for user",
            );
            res.status(500).json({ message: "Internal server error" });
        });
});








// -----------------------------------------------------------
// GET /instances/all
// -----------------------------------------------------------
//
// Used by:
//   - admin/AdminInstances.tsx — the all-instances table
// -----------------------------------------------------------

router.get("/all", isAuthenticated, isAdmin, (req, res) => {
    Instances.getAll()
        .then((instances) => res.json(instances))
        .catch((err) => {
            logger.error({ err }, "Error getting all instances");
            res.status(500).json({ message: "Internal server error" });
        });
});








// -----------------------------------------------------------
// GET /instances/all/running
// -----------------------------------------------------------
//
// The raw Proxmox view — every running VM, tracked by this
// app or not. View-only.
//
// Used by:
//   - admin/ProxmoxDashboard.tsx
// -----------------------------------------------------------

router.get("/all/running", isAuthenticated, isAdmin, async (_req, res) => {
    try {
        const vms = await proxmox.getVms();
        const running = vms.filter((vm) => vm.status === "running");
        return res.json(running);
    } catch (err) {
        logger.error({ err }, "Error getting running Proxmox instances");
        return res.status(500).json({ message: "Internal server error" });
    }
});








// -----------------------------------------------------------
// ALL /instances/proxy-auth
// -----------------------------------------------------------
//
// Forward-auth endpoint for the web-UI proxy
// (virtuallab.knf.vu.lt:8888). Caddy calls this on every
// proxied request: read the webTargetMachine cookie, verify
// the caller owns that instance, resolve the VM's web-UI
// target, and return it as X-Target-* headers. Any non-2xx
// response makes Caddy deny the request. The resolved IP is
// cached for 30 s because one page load fires this once per
// asset.
//
// NOTE: must be registered before "/:instanceId" so it
// isn't swallowed by it.
//
// Used by:
//   - the Caddy endpoint container's forward_auth block
// -----------------------------------------------------------

router.all("/proxy-auth", isAuthenticated, async (req, res) => {
    if (!req.user?.vu_id) return res.status(401).end();

    const machineId = parseInt(req.cookies?.webTargetMachine, 10);
    if (!machineId || isNaN(machineId)) return res.status(400).end();

    const hasAccess = await Instances.hasAccessTo(req.user.vu_id, machineId);
    if (!hasAccess) return res.status(403).end();

    const instance = await Instances.getById(machineId);
    if (!instance) return res.status(404).end();
    if (instance.status !== "running") return res.status(503).end();

    const template = instance.template_id
        ? await Templates.getById(instance.template_id)
        : null;
    if (template?.connection_type !== "web") return res.status(403).end();

    const cfg = (template.connection_config ?? {}) as Record<string, unknown>;
    const webPort = typeof cfg.port === "number" ? cfg.port : 443;
    const webProto = cfg.protocol === "http" ? "http" : "https";

    let ip: string | null = null;
    const cached = webProxyIpCache.get(machineId);
    if (cached && cached.exp > Date.now()) {
        ip = cached.ip;
    } else {
        ip = await Instances.getInsideNetIPv4(instance.proxmox_id);
        if (ip) {
            webProxyIpCache.set(machineId, {
                ip,
                exp: Date.now() + WEB_PROXY_IP_TTL_MS,
            });
        }
    }
    if (!ip) return res.status(503).end();

    res.setHeader("X-Target-Host", `${ip}:${webPort}`);
    res.setHeader("X-Target-Proto", webProto);
    return res.status(200).end();
});








// -----------------------------------------------------------
// GET /instances/:instanceId
// -----------------------------------------------------------
//
// Used by:
//   - Instances.tsx — the instance detail refresh
// -----------------------------------------------------------

router.get(
    "/:instanceId",
    isAuthenticated,
    validateRequest({ params: instanceIdParamSchema }),
    (req, res) => {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        Instances.hasAccessTo(
            req.user.vu_id,
            parseInt(req.params.instanceId as string),
        )
            .then((hasAccess) => {
                if (!hasAccess) {
                    return res.status(403).json({ message: "Forbidden" });
                }

                Instances.getById(parseInt(req.params.instanceId as string))
                    .then((instance) => {
                        if (!instance) {
                            res.status(404).json({
                                message: "Instance not found",
                            });
                        } else {
                            res.json(instance);
                        }
                    })
                    .catch((err) => {
                        logger.error(
                            {
                                err,
                                vu_id: req.user?.vu_id,
                                instanceId: req.params.instanceId,
                            },
                            "Error getting instance by ID",
                        );
                        res.status(500).json({
                            message: "Internal server error",
                        });
                    });
            })
            .catch((err) => {
                logger.error(
                    {
                        err,
                        vu_id: req.user?.vu_id,
                        instanceId: req.params.instanceId,
                    },
                    "Error checking access to instance",
                );
                res.status(500).json({ message: "Internal server error" });
            });
    },
);








// -----------------------------------------------------------
// POST /instances
// -----------------------------------------------------------
//
// Create, with the network provisioning wrapped around the
// clone. Order matters and each phase says why inline:
// validate template/profile/limit, resolve the network
// attachment, build shared infrastructure BEFORE cloning,
// clone+start, then per-VM firewall AFTER — with the VM
// destroyed if that last step fails, and the whole
// attachment compensated on any error.
//
// Used by:
//   - Index.tsx — the create-instance flow
// -----------------------------------------------------------

router.post(
    "/",
    isAuthenticated,
    validateRequest({ body: createInstanceSchema }),
    async (req, res) => {
        const { profile_id, template_id } = req.body as CreateInstanceDTO;

        try {
            if (!req.user) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            const template = await Templates.getById(template_id);
            if (template == null) {
                return res.status(404).json({
                    error: "Template not found",
                });
            }

            const profiles = await LabProfiles.getAll(req.user.role !== "admin");
            const profile = profiles.find(({ id }) => id === profile_id);
            if (!profile) {
                return res.status(404).json({ error: "Lab profile not found" });
            }

            const hasAccess = await Templates.hasAccess(
                req.user.role,
                template_id,
            );
            if (!hasAccess) {
                return res.status(403).json({
                    error: "User does not have access to this template",
                });
            }
            if (!profile.templates.some(({ id }) => id === template_id)) {
                return res.status(409).json({
                    error: "Template is not assigned to the selected lab profile",
                });
            }

            // Fast fail on the per-student VM limit (admins are exempt).
            // NOT the enforcement point: this reads a count that the ~30 s
            // clone can invalidate, which is how 20 parallel POSTs used to
            // yield 20 VMs against a limit of 1. createInstance re-checks it
            // inside the reservation transaction, under a per-owner lock, and
            // throws InstanceQuotaExceededError -- caught below. This exists
            // only to reject the common case before any Proxmox work.
            if (req.user.role !== "admin") {
                const [limit, existing] = await Promise.all([
                    metadata.get<number>("settings.limits.vmPerStudent"),
                    Instances.getAllForUser(req.user.vu_id),
                ]);
                const vmLimit = limit ?? 1;
                if (existing.length >= vmLimit) {
                    return res.status(429).json({
                        error: `VM limit reached (max ${vmLimit} per student)`,
                    });
                }
            }

            const mode = await getNetworkMode();
            const group = await getOrCreatePlannedGroup(
                req.user.vu_id,
                profile.id,
            );
            const attachment = await resolveNetworkAttachment(mode, group);
            let provisionedRevision = "";
            try {
                if (attachment.isolated) {
                    // Every piece of shared infrastructure the VM depends on has
                    // to exist before it is cloned onto the VNet: the VNet
                    // itself, the Access trunk, and the two appliances' VLAN
                    // interfaces. Running this first means a failure here never
                    // leaves a stray VM behind, and never hands a student a VM
                    // with no address and no path.
                    const provisioned = await ensureNetworkGroupInfrastructure(
                        attachment.group,
                        req.user.vu_id,
                    );
                    // The infrastructure revision the VNet, trunk and Access
                    // steps agreed on; recorded on the group so `active` names a
                    // revision an operator can check rather than a bare state.
                    provisionedRevision = provisioned.steps
                        .find(({ name }) => name === "access-policy")?.applied_revision
                        ?? provisioned.steps[0].applied_revision
                        ?? "";
                    logger.info(
                        {
                            networkGroupId: attachment.group.id,
                            vlanTag: attachment.group.vlan_tag,
                            steps: provisioned.steps,
                        },
                        "Reconciled network infrastructure for an isolated group",
                    );
                }
                if (mode === "dry-run") {
                    const plan = await getNetworkPlan();
                    const projection = plan.desired_state.groups.find(
                        ({ group_id }) => group_id === group.id,
                    );
                    if (!projection) {
                        throw new Error(`Network group ${group.id} is missing from the desired-state plan`);
                    }
                    logger.info(
                        {
                            networkMode: mode,
                            planRevision: plan.revision,
                            projection,
                        },
                        "Provisioning non-isolated VM on legacy bridge with projected network plan",
                    );
                }
                const instanceId = await Instances.createInstance(
                    req.user.vu_id,
                    template,
                    attachment.group.id,
                    attachment.bridge,
                    // Admins are exempt, exactly as in the pre-check above.
                    req.user.role !== "admin",
                );
                if (attachment.isolated) {
                    // Same-segment policy can only be applied once the VM
                    // exists, so this is the one step that runs after creation.
                    // A failure here destroys the VM rather than handing over an
                    // unfiltered one: traffic between VMs on a VLAN is switched
                    // at layer 2 and never reaches the Gateway, so without this
                    // there is nothing between one student's VM and the next.
                    const instance = await Instances.getById(instanceId);
                    if (!instance) {
                        throw new Error(`Instance ${instanceId} vanished before firewall policy`);
                    }
                    try {
                        const firewall = await ensureInstanceFirewall({
                            vmid: String(instance.proxmox_id),
                            group: attachment.group,
                            connectionType: template.connection_type,
                            connectionConfig: template.connection_config,
                            allowSameGroup: profile.allow_same_group,
                        });
                        logger.info(
                            { instanceId, vmid: instance.proxmox_id, firewall },
                            "Applied same-segment firewall policy to a student VM",
                        );
                        // Only now: every executor converged and the VM is
                        // filtered. Promoting earlier would publish a group as
                        // active while its VMs were still mutually reachable.
                        const promoted = await markNetworkGroupActive(
                            attachment.group.id,
                            provisionedRevision,
                        );
                        if (!promoted) {
                            // A concurrent teardown moved it out of `creating`.
                            // Not an error for this request -- the VM exists and
                            // is filtered -- but it must be visible.
                            logger.warn(
                                { networkGroupId: attachment.group.id },
                                "Network group left `creating` before it could be promoted",
                            );
                        }
                    } catch (error) {
                        await Instances.deleteInstance(instanceId).catch(
                            async (cleanupError) => {
                                // Reported, never rethrown: the firewall failure
                                // is the cause an operator needs, and losing it
                                // behind a cleanup error would hide why the VM
                                // existed.
                                logger.error(
                                    { err: cleanupError, instanceId },
                                    "Failed to remove a VM whose firewall could not be applied",
                                );
                                // Both the firewall write and the teardown
                                // failed -- the likeliest correlated failure,
                                // since they hit the same API. The VM may be
                                // running unfiltered on a shared VLAN, so mark
                                // it: without this the row looks healthy and the
                                // student can start and connect to it.
                                await Instances.markQuarantined(instanceId).catch(
                                    (markError) =>
                                        logger.error(
                                            { err: markError, instanceId },
                                            "Failed to quarantine an unfiltered VM",
                                        ),
                                );
                            },
                        );
                        throw error;
                    }
                }
                return res.json({ id: instanceId });
            } catch (error) {
                // The reservation transaction refused: the caller raced past
                // the pre-check above. No VM was created and no row survives,
                // so there is nothing to compensate -- just answer 429.
                if (error instanceof InstanceQuotaExceededError) {
                    await compensateNetworkAttachment(attachment, error.message);
                    return res.status(429).json({ error: error.message });
                }
                await compensateNetworkAttachment(
                    attachment,
                    error instanceof Error ? error.message : "Provisioning failed",
                );
                throw error;
            }
        } catch (err) {
            logger.error(err, "Error creating instance:");
            return res.status(500).json({ error: "Failed to create instance" });
        }
    },
);








// -----------------------------------------------------------
// DELETE /instances/:instanceId
// -----------------------------------------------------------
//
// Used by:
//   - Instances.tsx, admin/AdminInstances.tsx
// -----------------------------------------------------------

router.delete(
    "/:instanceId",
    isAuthenticated,
    validateRequest({ params: instanceIdParamSchema }),
    async (req, res) => {
        if (!req.user?.vu_id)
            return res.status(401).json({ error: "Unauthorized" });

        const instanceId = parseInt(req.params.instanceId as string);
        if (isNaN(instanceId))
            return res.status(400).json({ error: "Invalid instance ID" });

        const hasAccess = await Instances.hasAccessTo(
            req.user.vu_id,
            instanceId,
        );
        if (!hasAccess) return res.status(403).json({ error: "Unauthorized" });

        try {
            // Read before deleting: `network_group_id` lives on the row that is
            // about to disappear.
            const instance = await Instances.getById(instanceId);
            await Instances.deleteInstance(instanceId);
            // Inline rather than backgrounded. It only does real work when this
            // was the group's last VM, and a released VLAN that nobody observed
            // being released is how allocations leak. The guard returns
            // immediately when other VMs remain.
            await releaseNetworkGroupAfterInstance(
                instance?.network_group_id,
                req.user.vu_id,
            );
            return res.json({ message: "Instance deleted" });
        } catch (err) {
            logger.error({ err, instanceId }, "Error deleting instance");
            return res.status(500).json({ error: "Failed to delete instance" });
        }
    },
);








// -----------------------------------------------------------
// PATCH /instances/:instanceId/expirable
// -----------------------------------------------------------
//
// Used by:
//   - admin/AdminInstances.tsx — the expirable toggle
// -----------------------------------------------------------

router.patch(
    "/:instanceId/expirable",
    isAuthenticated,
    isAdmin,
    validateRequest({
        params: instanceIdParamSchema,
        body: setExpirableSchema,
    }),
    async (req, res) => {
        const instanceId = parseInt(req.params.instanceId as string);
        if (isNaN(instanceId)) {
            return res.status(400).json({ error: "Invalid instance ID" });
        }

        const expirable = req.body?.expirable;
        if (typeof expirable !== "boolean") {
            return res
                .status(400)
                .json({ error: "expirable must be a boolean" });
        }

        const instance = await Instances.getById(instanceId);
        if (!instance) {
            return res.status(404).json({ error: "Instance not found" });
        }

        try {
            await Instances.setExpirable(instanceId, expirable);
            return res.status(200).json({ ok: true });
        } catch (err) {
            logger.error(
                { err, instanceId, expirable },
                "Error setting instance expirable state",
            );
            return res
                .status(500)
                .json({ error: "Failed to update expirable state" });
        }
    },
);








// -----------------------------------------------------------
// POST /instances/:instanceId/start
// POST /instances/:instanceId/stop
// POST /instances/:instanceId/reboot
// -----------------------------------------------------------
//
// The three power buttons — same shape each time: access
// check, delegate to the controller, answer { ok: true }
// without waiting for the Proxmox task to finish.
//
// Used by:
//   - Instances.tsx, admin/AdminInstances.tsx
// -----------------------------------------------------------

router.post(
    "/:instanceId/start",
    isAuthenticated,
    validateRequest({ params: instanceIdParamSchema }),
    async (req, res) => {
        if (!req.user?.vu_id)
            return res.status(401).json({ error: "Unauthorized" });

        const targetInstance = parseInt(req.params.instanceId as string);
        const hasAccess = await Instances.hasAccessTo(
            req.user?.vu_id,
            targetInstance,
        );

        if (!hasAccess) {
            return res.status(400).json({ error: "Unauthorized" });
        }

        // A quarantined VM may be running unfiltered on a shared VLAN; do not
        // hand it back to its owner until an operator has dealt with it.
        const instance = await Instances.getById(targetInstance);
        if (instance?.quarantined) {
            return res.status(409).json({
                error: "This instance is quarantined and cannot be started. Contact an administrator.",
            });
        }

        const taskId = await Instances.startInstance(targetInstance);
        return res.status(200).json({ ok: true });
    },
);


router.post(
    "/:instanceId/stop",
    isAuthenticated,
    validateRequest({ params: instanceIdParamSchema }),
    async (req, res) => {
        if (!req.user?.vu_id)
            return res.status(401).json({ error: "Unauthorized" });

        const targetInstance = parseInt(req.params.instanceId as string);
        const hasAccess = await Instances.hasAccessTo(
            req.user?.vu_id,
            targetInstance,
        );

        if (!hasAccess) {
            return res.status(400).json({ error: "Unauthorized" });
        }

        const taskId = await Instances.stopInstance(targetInstance);
        return res.status(200).json({ ok: true });
    },
);


router.post(
    "/:instanceId/reboot",
    isAuthenticated,
    validateRequest({ params: instanceIdParamSchema }),
    async (req, res) => {
        if (!req.user?.vu_id)
            return res.status(401).json({ error: "Unauthorized" });

        const targetInstance = parseInt(req.params.instanceId as string);
        const hasAccess = await Instances.hasAccessTo(
            req.user?.vu_id,
            targetInstance,
        );

        if (!hasAccess) {
            return res.status(400).json({ error: "Unauthorized" });
        }

        const taskId = await Instances.rebootInstance(targetInstance);
        return res.status(200).json({ ok: true });
    },
);








// -----------------------------------------------------------
// POST /instances/:instanceId/session
// -----------------------------------------------------------
//
// The connect button. Starts the VM, then branches on the
// template's connection type:
//   web       — answers immediately; the :8888 proxy
//               resolves the IP itself via forward-auth
//   ssh       — Guacamole SSH connection ("<id>-ssh")
//   guacamole — RDP connection (name = instance id),
//               IP-refreshed if the VM moved
// For both Guacamole paths the student's Guacamole account
// is created on demand (password = their vu_id) and granted
// READ on the connection; the answer is a deep-link URL.
// The "creatorId"/"userId" placeholders in a template's
// connection credentials resolve to real IDs here.
//
// Used by:
//   - Instances.tsx / utils/instances.ts — the connect flow
// -----------------------------------------------------------

router.post(
    "/:instanceId/session",
    isAuthenticated,
    validateRequest({ params: instanceIdParamSchema }),
    async (req, res) => {
        if (!req.user?.vu_id)
            return res.status(401).json({ error: "Unauthorized" });

        const userId = req.user?.vu_id;

        const targetInstance = parseInt(req.params.instanceId as string);
        const hasAccess = await Instances.hasAccessTo(userId, targetInstance);

        if (!hasAccess) {
            return res.status(400).json({ error: "Unauthorized" });
        }

        const instance = await Instances.getById(targetInstance);
        if (!instance) {
            return res.status(400).json({ error: "Instance not found" });
        }

        // Same reasoning as /start: a quarantined VM is one whose firewall
        // policy could not be applied and which could not then be removed, so
        // handing out a session to it is handing out an unfiltered machine.
        // Note this route starts the VM further down, so the check must precede
        // that, not merely the connection build.
        if (instance.quarantined) {
            return res.status(409).json({
                error: "This instance is quarantined and cannot be connected to. Contact an administrator.",
            });
        }

        const template = instance.template_id
            ? await Templates.getById(instance.template_id)
            : null;

        const connectionType = template?.connection_type ?? "guacamole";
        const connectionConfig = template?.connection_config ?? {};

        const instanceOwnerId = instance.owner_id;

        // If instance is not running - start it and wait for ip.
        await proxmox.startVM(instance.proxmox_id);

        // web: the :8888 proxy resolves the IP itself via forward-auth, so we can
        // return immediately. The frontend sets the webTargetMachine cookie and
        // opens the proxy.
        if (connectionType === "web") {
            return res.status(200).json({ type: "web" });
        }

        // Get instance IP (needed for both ssh and guacamole)
        const instanceIp = await Instances.getInsideNetIPv4(
            instance.proxmox_id,
        );

        if (instanceIp == null) {
            return res.status(503).json({
                error: "VM is still starting up — please try again in a moment.",
            });
        }

        if (connectionType === "ssh") {
            const rawConfig = connectionConfig as SshConnectionConfig;
            const resolveCredential = (value: string | undefined) => {
                if (value === "creatorId") return instanceOwnerId ?? userId;
                if (value === "userId") return userId;
                return value ?? "user";
            };
            const username = resolveCredential(rawConfig.username);
            const password = resolveCredential(rawConfig.password);
            const port = rawConfig.port ?? 22;

            // Ensure Guacamole user exists, with a secret we hold
            const guacSecret = await ensureGuacamoleAccount(userId);

            const guacName = `${instance.id}-ssh`;
            let guacConn = await guacamole.getConnectionSummary(guacName);
            if (!guacConn) {
                await guacamole.createSshConnection(instanceIp, guacName, {
                    port,
                    username,
                    password,
                });
                guacConn = await guacamole.getConnectionSummary(guacName);
            } else {
                await guacamole.updateSshConnection(
                    guacName,
                    instanceIp,
                    guacConn.identifier,
                    { port, username, password },
                );
                guacConn = await guacamole.getConnectionSummary(guacName);
            }

            const guacId = guacConn?.identifier!;
            const perms = await guacamole.getUserPerms(userId);
            if (!(guacId in perms.connectionPermissions)) {
                await guacamole.giveUserAccessToMachine(userId, guacId);
            }

            return res.status(200).json({
                type: "guacamole",
                url: await guacamole.getSessionUrl(userId, guacSecret, guacId),
            });
        }

        // Default: guacamole (RDP) — create user only when needed
        const guacSecret = await ensureGuacamoleAccount(userId);

        const resolveGuacCredential = (value: string | undefined) => {
            if (value === "creatorId") return instanceOwnerId ?? userId;
            if (value === "userId") return userId;
            return value;
        };
        const guacConfig = connectionConfig as GuacamoleConnectionConfig;
        const guacCredentials = {
            username: resolveGuacCredential(guacConfig.username),
            password: resolveGuacCredential(guacConfig.password),
        };

        // Default: guacamole (RDP)
        const guacName = instance.id.toString();
        let guacConn = await guacamole.getConnectionSummary(guacName);
        if (!guacConn) {
            logger.info(
                {
                    userId: userId,
                    instanceIp: instanceIp,
                    instanceId: guacName,
                    requestId: req.id || null,
                },
                "Creating Guacamole connection",
            );

            await guacamole.createConnection(
                instanceIp,
                instanceOwnerId,
                guacName,
                guacCredentials,
            );
            guacConn = await guacamole.getConnectionSummary(guacName);
        } else {
            const summary = await guacamole.fetchConnectionParams(
                guacConn.identifier,
            );

            if (!summary) {
                logger.error(
                    `Failed to get connection summary by guacName: ${guacName}`,
                );
                return res.status(500).json({ error: "Server error." });
            }

            const guacIp = summary["hostname"];

            if (guacIp != instanceIp) {
                logger.info(
                    {
                        userId: userId,
                        instanceIp: instanceIp,
                        instanceId: guacName,
                        requestId: req.id || null,
                    },
                    "Updating Guacamole connection IP",
                );
            }

            await guacamole.updateConnectionIp(
                guacName,
                instanceOwnerId,
                instanceIp,
                guacConn.identifier,
                guacCredentials,
            );
            guacConn = await guacamole.getConnectionSummary(guacName);
        }

        const guacId = guacConn?.identifier!;
        const perms = await guacamole.getUserPerms(userId);

        if (!(guacId in perms.connectionPermissions)) {
            await guacamole.giveUserAccessToMachine(userId, guacId);
        }

        return res.status(200).json({
            type: "guacamole",
            url: await guacamole.getSessionUrl(userId, guacSecret, guacId),
        });
    },
);








// -----------------------------------------------------------
// POST /instances/:instanceId/renew
// -----------------------------------------------------------
//
// Resets run_until to now + defaultRuntimeHours.
//
// Used by:
//   - Instances.tsx — the renew button
// -----------------------------------------------------------

router.post(
    "/:instanceId/renew",
    isAuthenticated,
    validateRequest({ params: instanceIdParamSchema }),
    async (req, res) => {
        if (!req.user?.vu_id)
            return res.status(401).json({ error: "Unauthorized" });

        const targetInstance = parseInt(req.params.instanceId as string);
        const hasAccess = await Instances.hasAccessTo(
            req.user?.vu_id,
            targetInstance,
        );

        if (!hasAccess) {
            return res.status(400).json({ error: "Unauthorized" });
        }

        const instance = await Instances.getById(targetInstance);
        if (!instance) {
            return res.status(400).json({ error: "Instance not found" });
        }

        const [renewHours, maxHours] = await Promise.all([
            metadata.get<number>("settings.instances.defaultRuntimeHours"),
            metadata.get<number>("settings.limits.maxRuntimeHours"),
        ]);

        // Admins are exempt, as they are from the VM quota. For everyone else
        // the ceiling is absolute: without it this endpoint could be looped to
        // hold a VM indefinitely, defeating the only mechanism that reclaims
        // lab capacity.
        const cap = req.user.role === "admin" ? null : (maxHours ?? 24);

        await Instances.updateRuntimeHours(
            instance.id,
            renewHours ?? 3,
            cap,
        );

        const refreshed = await Instances.getById(instance.id);
        return res.status(200).json({
            ok: true,
            run_until: refreshed?.run_until ?? null,
        });
    },
);








// -----------------------------------------------------------
// GET /instances/:instanceId/ip
// -----------------------------------------------------------
//
// The guest's IPv4 list straight from the agent, with the
// two boot-time failure modes translated: VM not running →
// 409, agent not up yet → 503 (try again).
//
// Used by:
//   - Instances.tsx — the IP display
// -----------------------------------------------------------

router.get(
    "/:instanceId/ip",
    isAuthenticated,
    validateRequest({ params: instanceIdParamSchema }),
    async (req, res) => {
        if (!req.user?.vu_id)
            return res.status(401).json({ error: "Unauthorized" });

        const targetInstance = parseInt(req.params.instanceId as string);
        const hasAccess = await Instances.hasAccessTo(
            req.user?.vu_id,
            targetInstance,
        );

        if (!hasAccess) {
            return res.status(400).json({ error: "Unauthorized" });
        }

        const instance = await Instances.getById(targetInstance);
        if (!instance) {
            return res.status(400).json({ error: "Instance not found" });
        }

        try {
            return res
                .status(200)
                .json(await Instances.getIPv4(instance.proxmox_id));
        } catch (err: any) {
            const detailMsg: string =
                err?.details?.message ?? err?.message ?? "";

            if (err?.name === "ProxmoxApiError") {
                if (/vm \d+ is not running/i.test(detailMsg)) {
                    return res.status(409).json({ error: "VM is not running" });
                }
                if (/guest agent is not running/i.test(detailMsg)) {
                    return res.status(503).json({
                        error: "QEMU guest not running. Try again later.",
                    });
                }
            }

            throw err;
        }
    },
);








export { router as instancesRouter };
