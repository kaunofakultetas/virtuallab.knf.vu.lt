import { useEffect, useRef, useState } from "react";
import axios from "axios";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import InputLabel from "@mui/material/InputLabel";
import FormControl from "@mui/material/FormControl";
import PowerSettingsNewOutlinedIcon from "@mui/icons-material/PowerSettingsNewOutlined";
import RestartAltOutlinedIcon from "@mui/icons-material/RestartAltOutlined";
import StopOutlinedIcon from "@mui/icons-material/StopOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import UpdateOutlinedIcon from "@mui/icons-material/UpdateOutlined";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import type { Instance } from "@/types/instances";
import type { LabProfile } from "@/types/labProfiles";
import { getErrorMessage } from "@/utils/errors";
import { copyInstanceIp, networkLabel } from "@/utils/instances";

const statusColor: Record<string, "success" | "warning" | "error" | "default"> =
    {
        running: "success",
        stopped: "error",
        suspended: "warning",
        unknown: "default",
    };

export default function Instances() {
    const [instances, setInstances] = useState<Instance[]>([]);
    const [profiles, setProfiles] = useState<LabProfile[]>([]);
    const [fetching, setFetching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error" | "info";
    } | null>(null);

    const [createOpen, setCreateOpen] = useState(false);
    const [selectedProfileId, setSelectedProfileId] = useState<number | "">("");
    const [selectedTemplateId, setSelectedTemplateId] = useState<number | "">(
        "",
    );
    const [createLoading, setCreateLoading] = useState(false);
    const [createDialogError, setCreateDialogError] = useState<{
        message: string;
        severity: "error" | "warning";
    } | null>(null);

    const [actionLoading, setActionLoading] = useState<Record<string, boolean>>(
        {},
    );
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [copyingIpId, setCopyingIpId] = useState<string | null>(null);

    const prevInstancesRef = useRef<Instance[]>([]);
    const fetchInstancesRef = useRef<
        ((showLoading?: boolean) => Promise<void>) | null
    >(null);

    // Define fetchInstances as a stable ref so the interval always calls the latest version
    fetchInstancesRef.current = async (showLoading = true) => {
        if (showLoading) {
            setFetching(true);
            setError(null);
        }
        try {
            const response = await axios.get<Instance[]>("/api/instances");
            const next = Array.isArray(response.data) ? response.data : [];

            // Only update state if data actually changed
            const hasChanged =
                prevInstancesRef.current.length !== next.length ||
                next.some(
                    (n, i) =>
                        prevInstancesRef.current[i]?.id !== n.id ||
                        prevInstancesRef.current[i]?.status !== n.status ||
                        prevInstancesRef.current[i]?.name !== n.name ||
                        prevInstancesRef.current[i]?.run_until !== n.run_until,
                );

            if (hasChanged) {
                prevInstancesRef.current = next;
                setInstances(next);
            }
        } catch (err) {
            if (showLoading) {
                setError(getErrorMessage(err, "Failed to load instances."));
            }
        } finally {
            if (showLoading) {
                setFetching(false);
            }
        }
    };

    useEffect(() => {
        void fetchInstancesRef.current?.(true);
        void fetchProfiles();

        const interval = setInterval(() => {
            void fetchInstancesRef.current?.(false);
        }, 10_000);

        return () => clearInterval(interval);
    }, []);

    const fetchProfiles = async () => {
        try {
            const response = await axios.get<LabProfile[]>("/api/lab-profiles");
            const next = Array.isArray(response.data) ? response.data : [];
            setProfiles(next);
            if (next.length === 1) {
                setSelectedProfileId(next[0].id);
                if (next[0].templates.length === 1) {
                    setSelectedTemplateId(Number(next[0].templates[0].id));
                }
            }
        } catch {
            // Silently fail — profiles are only needed for creation
        }
    };

    const selectedProfile = profiles.find(({ id }) => id === selectedProfileId);
    const availableTemplates = selectedProfile?.templates ?? [];

    const withAction = async (
        instanceId: string,
        action: () => Promise<void>,
    ) => {
        setActionLoading((prev) => ({ ...prev, [instanceId]: true }));
        try {
            await action();
        } finally {
            setActionLoading((prev) => ({ ...prev, [instanceId]: false }));
        }
    };

    const handleStart = (instance: Instance) =>
        withAction(String(instance.id), async () => {
            await axios.get(`/api/instances/${instance.id}/start`);
            setSnackbar({
                message: "Instance starting...",
                severity: "info",
            });
            setTimeout(() => void fetchInstancesRef.current?.(false), 3000);
        });

    const handleStop = (instance: Instance) =>
        withAction(String(instance.id), async () => {
            await axios.get(`/api/instances/${instance.id}/stop`);
            setSnackbar({
                message: "Instance stopping...",
                severity: "info",
            });
            setTimeout(() => void fetchInstancesRef.current?.(false), 3000);
        });

    const handleReboot = (instance: Instance) =>
        withAction(String(instance.id), async () => {
            await axios.get(`/api/instances/${instance.id}/reboot`);
            setSnackbar({
                message: "Instance rebooting...",
                severity: "info",
            });
            setTimeout(() => void fetchInstancesRef.current?.(false), 3000);
        });

    const handleRenew = (instance: Instance) =>
        withAction(String(instance.id), async () => {
            await axios.get(`/api/instances/${instance.id}/renew`);
            setSnackbar({
                message: "Runtime extended by 3 hours.",
                severity: "success",
            });
            await fetchInstancesRef.current?.(false);
        });

    const handleConnect = async (instance: Instance) => {
        setActionLoading((prev) => ({
            ...prev,
            [`session-${instance.id}`]: true,
        }));
        try {
            const response = await axios.get<{ type: string; url?: string }>(
                `/api/instances/${instance.id}/session`,
            );
            if (response.data.type === "web") {
                // Cookies ignore ports, so this rides along to the :8888 proxy where
                // the backend forward-auth reads it. SameSite=Lax lets it accompany
                // the top-level navigation below.
                document.cookie = `webTargetMachine=${instance.id}; path=/; SameSite=Lax; Secure`;
                window.open(
                    `https://${window.location.hostname}:8888/`,
                    "_blank",
                );
            } else if (response.data.url) {
                window.open(response.data.url, "_blank");
            }
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(
                    err,
                    "Failed to open session.",
                ),
                severity: "error",
            });
        } finally {
            setActionLoading((prev) => ({
                ...prev,
                [`session-${instance.id}`]: false,
            }));
        }
    };

    const handleDelete = async (instance: Instance) => {
        const label = instance.name ?? `#${instance.id}`;
        if (!window.confirm(`Delete instance "${label}"? This will permanently destroy the VM.`)) return;
        setDeletingId(String(instance.id));
        try {
            await axios.delete(`/api/instances/${instance.id}`);
            setInstances((prev) => prev.filter((i) => i.id !== instance.id));
            setSnackbar({ message: "Instance deleted.", severity: "success" });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to delete instance."),
                severity: "error",
            });
        } finally {
            setDeletingId(null);
        }
    };

    const handleCopyIp = async (instance: Instance) => {
        setCopyingIpId(String(instance.id));
        const result = await copyInstanceIp(instance.id);
        setSnackbar(
            result.ok
                ? { message: `Copied: ${result.ip}`, severity: "success" }
                : { message: result.message, severity: "error" },
        );
        setCopyingIpId(null);
    };

    const handleCreate = async () => {
        if (!selectedProfileId || !selectedTemplateId) return;
        setCreateLoading(true);
        setCreateDialogError(null);
        try {
            await axios.post("/api/instances", {
                profile_id: selectedProfileId,
                template_id: selectedTemplateId,
            });
            setCreateOpen(false);
            setSelectedProfileId("");
            setSelectedTemplateId("");
            setCreateDialogError(null);
            setSnackbar({
                message: "Instance created successfully.",
                severity: "success",
            });
            await fetchInstancesRef.current?.(false);
        } catch (err) {
            if (axios.isAxiosError(err) && err.response?.status === 429) {
                setCreateDialogError({
                    message:
                        err.response?.data?.error ??
                        "You have reached the maximum number of allowed instances. Delete an existing one to create a new instance.",
                    severity: "warning",
                });
            } else {
                setCreateDialogError({
                    message: getErrorMessage(err, "Failed to create instance."),
                    severity: "error",
                });
            }
        } finally {
            setCreateLoading(false);
        }
    };

    const formatRunUntil = (runUntil: string | null): string => {
        if (!runUntil) return "No limit";
        const date = new Date(runUntil);
        const now = new Date();
        const diffMs = date.getTime() - now.getTime();
        if (diffMs <= 0) return "Expired";
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        return `${hours}h ${minutes}m remaining`;
    };

    return (
        <Stack spacing={2}>
            <Box
                sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 2,
                }}
            >
                <Box>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                        My Instances
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Manage your virtual machines.
                    </Typography>
                </Box>
                <Button
                    variant="contained"
                    startIcon={<AddOutlinedIcon fontSize="small" />}
                    onClick={() => setCreateOpen(true)}
                    disabled={profiles.length === 0}
                >
                    New instance
                </Button>
            </Box>

            {error && <Alert severity="error">{error}</Alert>}

            <Paper sx={{ overflowX: "auto" }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>Name</TableCell>
                            <TableCell>Status</TableCell>
                            <TableCell>Network</TableCell>
                            <TableCell>Runtime</TableCell>
                            <TableCell align="right">Actions</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {fetching ? (
                            <TableRow>
                                <TableCell colSpan={5}>
                                    <Box
                                        sx={{
                                            display: "flex",
                                            justifyContent: "center",
                                            py: 3,
                                        }}
                                    >
                                        <CircularProgress size={24} />
                                    </Box>
                                </TableCell>
                            </TableRow>
                        ) : instances.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5}>
                                    <Typography
                                        variant="body2"
                                        color="text.secondary"
                                        sx={{ py: 2 }}
                                    >
                                        No instances yet. Click "New instance"
                                        to create one.
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ) : (
                            instances.map((instance) => {
                                const isLoading =
                                    actionLoading[String(instance.id)] ||
                                    actionLoading[`session-${instance.id}`];
                                const isCopyingIp =
                                    copyingIpId === String(instance.id);
                                const network = networkLabel(instance);
                                return (
                                    <TableRow key={instance.id}>
                                        <TableCell>
                                            <Typography
                                                variant="body2"
                                                sx={{ fontWeight: 600 }}
                                            >
                                                {instance.name ??
                                                    `Instance ${instance.id}`}{" "}
                                                <Typography
                                                    component="span"
                                                    variant="caption"
                                                    color="text.disabled"
                                                >
                                                    #{instance.id}
                                                </Typography>
                                            </Typography>
                                        </TableCell>
                                        <TableCell>
                                            <Chip
                                                size="small"
                                                label={
                                                    instance.status ?? "unknown"
                                                }
                                                color={
                                                    statusColor[
                                                        instance.status ??
                                                            "unknown"
                                                    ] ?? "default"
                                                }
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <Typography variant="body2">
                                                {network.primary}
                                            </Typography>
                                            <Typography
                                                variant="caption"
                                                color="text.secondary"
                                                sx={{
                                                    fontFamily: "monospace",
                                                    display: "block",
                                                }}
                                            >
                                                {network.detail}
                                            </Typography>
                                        </TableCell>
                                        <TableCell>
                                            <Typography
                                                variant="body2"
                                                color="text.secondary"
                                            >
                                                {formatRunUntil(
                                                    instance.run_until,
                                                )}
                                            </Typography>
                                        </TableCell>
                                        <TableCell align="right">
                                            {instance.status === "running" && (
                                                <>
                                                    <Tooltip title="Connect">
                                                        <span>
                                                            <IconButton
                                                                size="small"
                                                                onClick={() =>
                                                                    handleConnect(
                                                                        instance,
                                                                    )
                                                                }
                                                                disabled={
                                                                    actionLoading[
                                                                        `session-${instance.id}`
                                                                    ]
                                                                }
                                                            >
                                                                {actionLoading[
                                                                    `session-${instance.id}`
                                                                ] ? (
                                                                    <CircularProgress
                                                                        size={
                                                                            18
                                                                        }
                                                                    />
                                                                ) : (
                                                                    <OpenInNewOutlinedIcon fontSize="small" />
                                                                )}
                                                            </IconButton>
                                                        </span>
                                                    </Tooltip>
                                                    <Tooltip title="Copy internal IP">
                                                        <span>
                                                            <IconButton
                                                                size="small"
                                                                onClick={() =>
                                                                    handleCopyIp(
                                                                        instance,
                                                                    )
                                                                }
                                                                disabled={
                                                                    isCopyingIp
                                                                }
                                                            >
                                                                {isCopyingIp ? (
                                                                    <CircularProgress
                                                                        size={
                                                                            18
                                                                        }
                                                                    />
                                                                ) : (
                                                                    <ContentCopyOutlinedIcon fontSize="small" />
                                                                )}
                                                            </IconButton>
                                                        </span>
                                                    </Tooltip>
                                                    <Tooltip title="Reboot">
                                                        <span>
                                                            <IconButton
                                                                size="small"
                                                                onClick={() =>
                                                                    handleReboot(
                                                                        instance,
                                                                    )
                                                                }
                                                                disabled={
                                                                    isLoading
                                                                }
                                                            >
                                                                <RestartAltOutlinedIcon fontSize="small" />
                                                            </IconButton>
                                                        </span>
                                                    </Tooltip>
                                                    <Tooltip title="Stop">
                                                        <span>
                                                            <IconButton
                                                                size="small"
                                                                onClick={() =>
                                                                    handleStop(
                                                                        instance,
                                                                    )
                                                                }
                                                                disabled={
                                                                    isLoading
                                                                }
                                                            >
                                                                <StopOutlinedIcon fontSize="small" />
                                                            </IconButton>
                                                        </span>
                                                    </Tooltip>
                                                </>
                                            )}
                                            {instance.status === "stopped" && (
                                                <Tooltip title="Start">
                                                    <span>
                                                        <IconButton
                                                            size="small"
                                                            onClick={() =>
                                                                handleStart(
                                                                    instance,
                                                                )
                                                            }
                                                            disabled={isLoading}
                                                        >
                                                            <PowerSettingsNewOutlinedIcon fontSize="small" />
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>
                                            )}
                                            <Tooltip title="Extend runtime (+3h)">
                                                <span>
                                                    <IconButton
                                                        size="small"
                                                        onClick={() =>
                                                            handleRenew(
                                                                instance,
                                                            )
                                                        }
                                                        disabled={isLoading}
                                                    >
                                                        <UpdateOutlinedIcon fontSize="small" />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                            <Tooltip title="Delete">
                                                <span>
                                                    <IconButton
                                                        size="small"
                                                        color="error"
                                                        onClick={() =>
                                                            handleDelete(
                                                                instance,
                                                            )
                                                        }
                                                        disabled={
                                                            deletingId ===
                                                            String(instance.id)
                                                        }
                                                    >
                                                        {deletingId ===
                                                        String(instance.id) ? (
                                                            <CircularProgress
                                                                size={18}
                                                                color="error"
                                                            />
                                                        ) : (
                                                            <DeleteOutlinedIcon fontSize="small" />
                                                        )}
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        </TableCell>
                                    </TableRow>
                                );
                            })
                        )}
                    </TableBody>
                </Table>
            </Paper>

            {/* Create Instance Dialog */}
            <Dialog
                open={createOpen}
                onClose={() => {
                    setCreateOpen(false);
                    setSelectedProfileId("");
                    setSelectedTemplateId("");
                    setCreateDialogError(null);
                }}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>Create instance</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        {createDialogError && (
                            <Alert severity={createDialogError.severity}>
                                {createDialogError.message}
                            </Alert>
                        )}
                        <FormControl fullWidth>
                            <InputLabel>Lab profile</InputLabel>
                            <Select
                                value={selectedProfileId}
                                label="Lab profile"
                                onChange={(event) => {
                                    const profileId = Number(event.target.value);
                                    const profile = profiles.find(({ id }) => id === profileId);
                                    setSelectedProfileId(profileId);
                                    setSelectedTemplateId(
                                        profile?.templates.length === 1
                                            ? Number(profile.templates[0].id)
                                            : "",
                                    );
                                }}
                            >
                                {profiles.map((profile) => (
                                    <MenuItem key={profile.id} value={profile.id}>
                                        {profile.name}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <FormControl fullWidth>
                            <InputLabel>Template</InputLabel>
                            <Select
                                value={selectedTemplateId}
                                label="Template"
                                onChange={(e) =>
                                    setSelectedTemplateId(
                                        Number(e.target.value),
                                    )
                                }
                                disabled={!selectedProfileId}
                            >
                                {availableTemplates.map((t) => (
                                    <MenuItem key={t.id} value={t.id}>
                                        {t.name}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button
                        onClick={() => {
                            setCreateOpen(false);
                            setSelectedProfileId("");
                            setSelectedTemplateId("");
                            setCreateDialogError(null);
                        }}
                        disabled={createLoading}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="contained"
                        onClick={handleCreate}
                        disabled={!selectedProfileId || !selectedTemplateId || createLoading}
                    >
                        {createLoading ? (
                            <CircularProgress size={20} />
                        ) : (
                            "Create"
                        )}
                    </Button>
                </DialogActions>
            </Dialog>

            <Snackbar
                open={Boolean(snackbar)}
                autoHideDuration={4000}
                onClose={() => setSnackbar(null)}
            >
                <Alert
                    onClose={() => setSnackbar(null)}
                    severity={snackbar?.severity ?? "info"}
                    sx={{ width: "100%" }}
                >
                    {snackbar?.message}
                </Alert>
            </Snackbar>
        </Stack>
    );
}

