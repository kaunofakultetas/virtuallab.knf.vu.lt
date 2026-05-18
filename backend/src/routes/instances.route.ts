import { Instances } from "@/controllers/instances.controller";
import { Templates } from "@/controllers/templates.controller";
import { guacamole } from "@/guacamole";
import { isAdmin, isAuthenticated } from "@/middleware/auth.middleware";
import { validateRequest } from "@/middleware/zod-validation.middleware";
import { proxmox } from "@/proxmox";
import { CreateInstanceDTO } from "@/types/instances";
import { createInstanceSchema } from "@/types/validators/instances.zod";
import { logger } from "@/utils/logger";
import { Router } from "express";

const router = Router();

// Gets all instances for current user
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

// Gets all instances for all users, admin only
router.get("/all", isAuthenticated, isAdmin, (req, res) => {
    Instances.getAll()
        .then((instances) => res.json(instances))
        .catch((err) => {
            logger.error({ err }, "Error getting all instances");
            res.status(500).json({ message: "Internal server error" });
        });
});

// Gets instance by ID, only if it belongs to current user or user is admin
router.get("/:instanceId", isAuthenticated, (req, res) => {
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
                        res.status(404).json({ message: "Instance not found" });
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
                    res.status(500).json({ message: "Internal server error" });
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
});

// Creates new instance, only for current user
router.post(
    "/",
    isAuthenticated,
    validateRequest({ body: createInstanceSchema }),
    async (req, res) => {
        const { template_id } = req.body as CreateInstanceDTO;

        try {
            const template = await Templates.getById(template_id);
            if (template == null) {
                return res.status(400).json({
                    error: "Template with the provided template_id doesn't exist",
                });
            }

            // Perms check for template
            if (!req.user?.role) throw Error("req.user is missing .role param");
            const hasAccess = await Templates.hasAccess(
                req.user?.role,
                template_id,
            );
            if (!hasAccess) {
                return res.status(400).json({
                    error: "User does not have access to this template",
                });
            }

            // Create instance
            const resp = await Instances.createInstance(
                req.user?.vu_id,
                template,
            );
            return res.json({ id: resp });
        } catch (err) {
            logger.error(err, "Error creating instance:");
            return res.status(500).json({ error: "Failed to create instance" });
        }
    },
);

// Deletes instance by ID, only if it belongs to current user or user is admin
router.delete("/:instanceId", isAuthenticated, (req, res) => {});

// Start instance by ID, only if it belongs to current user or user is admin
router.get("/:instanceId/start", isAuthenticated, async (req, res) => {
    if (!req.user?.vu_id) return;

    const targetInstance = parseInt(req.params.instanceId as string);
    const hasAccess = await Instances.hasAccessTo(
        req.user?.vu_id,
        targetInstance,
    );

    if (!hasAccess) {
        return res.status(400).json({ error: "Unauthorized" });
    }

    const taskId = await Instances.startInstance(targetInstance);
    return res.status(200).json({ ok: true });
});

// Stop instance by ID, only if it belongs to current user or user is admin
router.get("/:instanceId/stop", isAuthenticated, async (req, res) => {
    if (!req.user?.vu_id) return;

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
});

// Reboot instance by ID, only if it belongs to current user or user is admin
router.get("/:instanceId/reboot", isAuthenticated, async (req, res) => {
    if (!req.user?.vu_id) return;

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
});

// Get GUI connection URL for instance by ID, only if it belongs to current user or user is admin
router.get("/:instanceId/session", isAuthenticated, async (req, res) => {
    if (!req.user?.vu_id) return;

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

    // If instance is not running - start it and wait for ip.
    await proxmox.startVM(instance.proxmox_id);

    // Does guacamole user exist?
    let guacUser = await guacamole.getUser(userId);
    if (!guacUser) {
        guacUser = await guacamole.createUser(userId, userId);
    }

    // Does guacamole connection to the machine exist?
    const guacName = instance.id.toString();
    let guacConn = await guacamole.getConnectionSummary(guacName);
    if (!guacConn) {
        // Get instance IP
        const instanceIp = await Instances.getInsideNetIPv4(
            instance.proxmox_id,
        );

        if (instanceIp == null) {
            return res
                .status(500)
                .json({ error: "Timed out, is server starting up?" });
        }

        logger.info(
            {
                userId: userId,
                instanceIp: instanceIp,
                instanceId: guacName,
            },
            "Creating Guacamole connection",
        );

        await guacamole.createConnection(instanceIp, userId, guacName);
        guacConn = await guacamole.getConnectionSummary(guacName);
    }

    // Does guac user have perms?
    const guacId = guacConn?.identifier!;
    const perms = await guacamole.getUserPerms(userId);

    if (!(guacId in perms.connectionPermissions)) {
        await guacamole.giveUserAccessToMachine(userId, guacId);
    }

    // Should be good to go - get and return session url
    return res
        .status(200)
        .json({ url: await guacamole.getSessionUrl(userId, guacId) });
});

// Get machines ip within the local network
router.get("/:instanceId/ip", isAuthenticated, async (req, res) => {
    if (!req.user?.vu_id) return;

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
        const detailMsg: string = err?.details?.message ?? err?.message ?? "";

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
});

export { router as instancesRouter };
