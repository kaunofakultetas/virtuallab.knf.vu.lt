import { useEffect, useState } from "react";
import axios from "axios";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Chip from "@mui/material/Chip";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import RestoreOutlinedIcon from "@mui/icons-material/RestoreOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import { getErrorMessage } from "@/utils/errors";

interface MetadataEntry {
    key: string;
    value: string | number | boolean | null;
    default: string | number | boolean | null;
    updated_at: string | null;
}

interface SettingMeta {
    label: string;
    description: string;
    type: "number" | "string";
}

interface NetworkReadiness {
    mode: "legacy" | "dry-run" | "active";
    ready_for_active: boolean;
    checks: Array<{
        key: string;
        ready: boolean;
        detail: string;
    }>;
    desired_state: {
        profiles: number;
        templates: number;
        groups: Record<"planned" | "creating" | "active" | "deleting" | "error", number>;
        linked_instances: number;
    };
}

const SETTINGS_META: Record<string, SettingMeta> = {
    "settings.network.mode": {
        label: "Network mode",
        description: "Legacy provisioning, non-mutating dry-run, or readiness-gated active networking",
        type: "string",
    },
    "settings.limits.vmPerStudent": {
        label: "VMs per student",
        description: "Maximum number of VMs a student can have at once",
        type: "number",
    },
    "settings.network.insideIpPrefix": {
        label: "Inside network IP prefix",
        description: "IP prefix used to identify VMs on the internal network",
        type: "string",
    },
    "settings.instances.ipWaitTimeoutMs": {
        label: "IP wait timeout (ms)",
        description: "Max time to wait for a VM to get an IP address",
        type: "number",
    },
    "settings.instances.ipPollIntervalMs": {
        label: "IP poll interval (ms)",
        description: "How often to poll for a VM's IP address while waiting",
        type: "number",
    },
    "settings.proxmox.minVmId": {
        label: "Minimum VM ID",
        description: "Proxmox VMID at which student VM IDs start",
        type: "number",
    },
    "settings.instances.defaultRuntimeHours": {
        label: "Default runtime (hours)",
        description: "Hours until a newly created instance expires",
        type: "number",
    },
    "settings.guacamole.parentIdentifier": {
        label: "Guacamole folder ID",
        description: "Guacamole parent connection group identifier",
        type: "string",
    },
    "settings.guacamole.requestTimeoutMs": {
        label: "Guacamole request timeout (ms)",
        description: "HTTP timeout for Guacamole API calls",
        type: "number",
    },
};

export default function Settings() {
    const [entries, setEntries] = useState<MetadataEntry[]>([]);
    const [fetching, setFetching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error" | "info";
    } | null>(null);

    const [editOpen, setEditOpen] = useState(false);
    const [editEntry, setEditEntry] = useState<MetadataEntry | null>(null);
    const [editValue, setEditValue] = useState("");
    const [editLoading, setEditLoading] = useState(false);

    const [resettingKey, setResettingKey] = useState<string | null>(null);
    const [readiness, setReadiness] = useState<NetworkReadiness | null>(null);
    const [readinessLoading, setReadinessLoading] = useState(false);
    const [readinessError, setReadinessError] = useState<string | null>(null);

    const fetchSettings = async () => {
        setFetching(true);
        setError(null);
        try {
            const response = await axios.get<MetadataEntry[]>("/api/metadata");
            setEntries(Array.isArray(response.data) ? response.data : []);
        } catch (err) {
            setError(getErrorMessage(err, "Failed to load settings."));
        } finally {
            setFetching(false);
        }
    };

    const fetchNetworkReadiness = async () => {
        setReadinessLoading(true);
        setReadinessError(null);
        try {
            const response = await axios.get<NetworkReadiness>("/api/network/readiness");
            setReadiness(response.data);
        } catch (err) {
            setReadinessError(getErrorMessage(err, "Failed to evaluate network readiness."));
        } finally {
            setReadinessLoading(false);
        }
    };

    useEffect(() => {
        void Promise.resolve().then(() =>
            Promise.all([fetchSettings(), fetchNetworkReadiness()]),
        );
    }, []);

    const openEditDialog = (entry: MetadataEntry) => {
        setEditEntry(entry);
        setEditValue(String(entry.value ?? ""));
        setEditOpen(true);
    };

    const handleEditClose = () => {
        setEditOpen(false);
        setEditEntry(null);
        setEditValue("");
    };

    const handleSave = async () => {
        if (!editEntry) return;
        setEditLoading(true);
        const meta = SETTINGS_META[editEntry.key];
        const parsed =
            meta?.type === "number" ? Number(editValue) : editValue;

        if (meta?.type === "number" && isNaN(parsed as number)) {
            setSnackbar({ message: "Value must be a number.", severity: "error" });
            setEditLoading(false);
            return;
        }

        try {
            await axios.patch(`/api/metadata/${encodeURIComponent(editEntry.key)}`, {
                value: parsed,
            });
            setEntries((prev) =>
                prev.map((e) =>
                    e.key === editEntry.key ? { ...e, value: parsed } : e,
                ),
            );
            setSnackbar({ message: "Setting updated.", severity: "success" });
            handleEditClose();
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to update setting."),
                severity: "error",
            });
        } finally {
            setEditLoading(false);
        }
    };

    const handleReset = async (entry: MetadataEntry) => {
        if (!window.confirm(`Reset "${SETTINGS_META[entry.key]?.label ?? entry.key}" to default (${String(entry.default)})?`)) return;
        setResettingKey(entry.key);
        try {
            await axios.delete(`/api/metadata/${encodeURIComponent(entry.key)}`);
            setEntries((prev) =>
                prev.map((e) =>
                    e.key === entry.key ? { ...e, value: entry.default } : e,
                ),
            );
            setSnackbar({ message: "Setting reset to default.", severity: "info" });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to reset setting."),
                severity: "error",
            });
        } finally {
            setResettingKey(null);
        }
    };

    const isAtDefault = (entry: MetadataEntry) =>
        String(entry.value) === String(entry.default);

    const meta = editEntry ? SETTINGS_META[editEntry.key] : null;

    return (
        <Stack spacing={2}>
            <Box>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                    Settings
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    Manage lab-wide configuration. Changes take effect immediately.
                </Typography>
            </Box>

            {error && <Alert severity="error">{error}</Alert>}

            <Paper sx={{ p: 2 }}>
                <Stack spacing={2}>
                    <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: "center", justifyContent: "space-between" }}
                    >
                        <Box>
                            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                                Network readiness
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                Non-mutating checks required before active networking can be enabled.
                            </Typography>
                        </Box>
                        <Tooltip title="Refresh readiness">
                            <span>
                                <IconButton
                                    onClick={() => void fetchNetworkReadiness()}
                                    disabled={readinessLoading}
                                >
                                    {readinessLoading ? (
                                        <CircularProgress size={20} />
                                    ) : (
                                        <RefreshOutlinedIcon />
                                    )}
                                </IconButton>
                            </span>
                        </Tooltip>
                    </Stack>

                    {readinessError && <Alert severity="error">{readinessError}</Alert>}

                    {readiness && (
                        <>
                            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
                                <Chip label={`Mode: ${readiness.mode}`} variant="outlined" />
                                <Chip
                                    label={readiness.ready_for_active ? "Ready for active" : "Active blocked"}
                                    color={readiness.ready_for_active ? "success" : "warning"}
                                />
                                <Chip label={`${readiness.desired_state.profiles} profiles`} variant="outlined" />
                                <Chip label={`${readiness.desired_state.templates} templates`} variant="outlined" />
                                <Chip label={`${readiness.desired_state.groups.planned} planned groups`} variant="outlined" />
                                <Chip label={`${readiness.desired_state.linked_instances} linked instances`} variant="outlined" />
                            </Stack>
                            {readiness.checks
                                .filter((check) => !check.ready)
                                .map((check) => (
                                    <Alert severity="warning" key={check.key}>
                                        {check.detail}
                                    </Alert>
                                ))}
                        </>
                    )}
                </Stack>
            </Paper>

            <Paper sx={{ overflowX: "auto" }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>Setting</TableCell>
                            <TableCell>Current value</TableCell>
                            <TableCell>Default</TableCell>
                            <TableCell align="right">Actions</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {fetching ? (
                            <TableRow>
                                <TableCell colSpan={4}>
                                    <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
                                        <CircularProgress size={24} />
                                    </Box>
                                </TableCell>
                            </TableRow>
                        ) : entries.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={4}>
                                    <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                                        No settings found.
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ) : (
                            entries.map((entry) => {
                                const entryMeta = SETTINGS_META[entry.key];
                                return (
                                    <TableRow key={entry.key}>
                                        <TableCell>
                                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                                {entryMeta?.label ?? entry.key}
                                            </Typography>
                                            {entryMeta?.description && (
                                                <Typography variant="caption" color="text.secondary">
                                                    {entryMeta.description}
                                                </Typography>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                                                <Typography
                                                    variant="body2"
                                                    sx={{ fontFamily: "monospace" }}
                                                >
                                                    {String(entry.value)}
                                                </Typography>
                                                {!isAtDefault(entry) && (
                                                    <Chip
                                                        label="modified"
                                                        size="small"
                                                        color="warning"
                                                        variant="outlined"
                                                    />
                                                )}
                                            </Stack>
                                        </TableCell>
                                        <TableCell>
                                            <Typography
                                                variant="body2"
                                                color="text.secondary"
                                                sx={{ fontFamily: "monospace" }}
                                            >
                                                {String(entry.default)}
                                            </Typography>
                                        </TableCell>
                                        <TableCell align="right">
                                            <Tooltip title="Edit">
                                                <IconButton
                                                    size="small"
                                                    onClick={() => openEditDialog(entry)}
                                                >
                                                    <EditOutlinedIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Reset to default">
                                                <span>
                                                    <IconButton
                                                        size="small"
                                                        onClick={() => handleReset(entry)}
                                                        disabled={
                                                            isAtDefault(entry) ||
                                                            resettingKey === entry.key
                                                        }
                                                    >
                                                        {resettingKey === entry.key ? (
                                                            <CircularProgress size={18} />
                                                        ) : (
                                                            <RestoreOutlinedIcon fontSize="small" />
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

            {/* Edit dialog */}
            <Dialog open={editOpen} onClose={handleEditClose} maxWidth="sm" fullWidth>
                <DialogTitle>
                    Edit: {meta?.label ?? editEntry?.key}
                </DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        {meta?.description && (
                            <Typography variant="body2" color="text.secondary">
                                {meta.description}
                            </Typography>
                        )}
                        <TextField
                            label="Value"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            type={meta?.type === "number" ? "number" : "text"}
                            fullWidth
                            autoFocus
                            helperText={`Default: ${String(editEntry?.default ?? "")}`}
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleEditClose} disabled={editLoading}>
                        Cancel
                    </Button>
                    <Button
                        variant="contained"
                        onClick={handleSave}
                        disabled={editLoading || editValue.trim() === ""}
                    >
                        {editLoading ? <CircularProgress size={20} /> : "Save"}
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

