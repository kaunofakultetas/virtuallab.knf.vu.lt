import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import PeopleOutlinedIcon from "@mui/icons-material/PeopleOutlined";
import ComputerOutlinedIcon from "@mui/icons-material/ComputerOutlined";
import PowerSettingsNewOutlinedIcon from "@mui/icons-material/PowerSettingsNewOutlined";
import ViewModuleOutlinedIcon from "@mui/icons-material/ViewModuleOutlined";
import StopOutlinedIcon from "@mui/icons-material/StopOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import UpdateOutlinedIcon from "@mui/icons-material/UpdateOutlined";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import { useAuth } from "@/utils/AuthGuard";
import { getErrorMessage } from "@/utils/errors";
import type { Instance, ProxmoxStatus } from "@/types/instances";
import type { User } from "@/types/users";

// ─── Shared helpers ───────────────────────────────────────────────────────────

const statusColor: Record<string, "success" | "warning" | "error" | "default"> =
    {
        running: "success",
        stopped: "error",
        suspended: "warning",
        unknown: "default",
    };

const statusBorder: Record<ProxmoxStatus, string> = {
    running: "#2e7d32",
    stopped: "#9e9e9e",
    suspended: "#ed6c02",
    unknown: "#bdbdbd",
};

function formatRunUntil(runUntil: string | null): {
    text: string;
    warning: boolean;
} {
    if (!runUntil) return { text: "No expiry", warning: false };
    const ms = new Date(runUntil).getTime() - Date.now();
    if (ms <= 0) return { text: "Expired", warning: true };
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return {
        text: h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining`,
        warning: ms < 30 * 60_000,
    };
}

// ─── StatCard (admin) ─────────────────────────────────────────────────────────

interface StatCardProps {
    icon: React.ReactNode;
    label: string;
    value: number;
    color: string;
    href?: string;
}

function StatCard({ icon, label, value, color, href }: StatCardProps) {
    const navigate = useNavigate();
    return (
        <Paper
            onClick={href ? () => navigate(href) : undefined}
            sx={{
                p: 2.5,
                display: "flex",
                alignItems: "center",
                gap: 2,
                flex: 1,
                minWidth: 150,
                cursor: href ? "pointer" : "default",
                "&:hover": href ? { bgcolor: "action.hover" } : undefined,
            }}
        >
            <Box
                sx={{
                    width: 44,
                    height: 44,
                    borderRadius: 2,
                    bgcolor: color,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    "& svg": { color: "#fff" },
                }}
            >
                {icon}
            </Box>
            <Box>
                <Typography variant="h4" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
                    {value}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    {label}
                </Typography>
            </Box>
        </Paper>
    );
}

// ─── Admin dashboard ──────────────────────────────────────────────────────────

function AdminDashboard() {
    const navigate = useNavigate();
    const [users, setUsers] = useState<User[]>([]);
    const [instances, setInstances] = useState<Instance[]>([]);
    const [templateCount, setTemplateCount] = useState(0);
    const [fetching, setFetching] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

    const fetchAll = async (showLoading = true) => {
        if (showLoading) {
            setFetching(true);
            setError(null);
        }
        try {
            const [usersRes, instancesRes, templatesRes] = await Promise.all([
                axios.get<User[]>("/api/auth/users"),
                axios.get<Instance[]>("/api/instances/all"),
                axios.get<unknown[]>("/api/templates"),
            ]);
            setUsers(Array.isArray(usersRes.data) ? usersRes.data : []);
            setInstances(
                Array.isArray(instancesRes.data) ? instancesRes.data : [],
            );
            setTemplateCount(
                Array.isArray(templatesRes.data) ? templatesRes.data.length : 0,
            );
            setLastRefreshed(new Date());
        } catch (err) {
            setError(getErrorMessage(err, "Failed to load dashboard data."));
        } finally {
            if (showLoading) setFetching(false);
        }
    };

    useEffect(() => {
        void fetchAll();
    }, []);

    const now = Date.now();
    const runningCount = instances.filter((i) => i.status === "running").length;
    const expiringSoon = instances
        .filter((i) => {
            if (!i.run_until) return false;
            const ms = new Date(i.run_until).getTime() - now;
            return ms > 0 && ms < 60 * 60_000;
        })
        .sort(
            (a, b) =>
                new Date(a.run_until!).getTime() -
                new Date(b.run_until!).getTime(),
        );

    return (
        <Stack spacing={3}>
            <Box
                sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-end",
                    gap: 2,
                }}
            >
                <Box>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                        Dashboard
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Lab system overview
                    </Typography>
                </Box>
                <Box
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                    }}
                >
                    {lastRefreshed && (
                        <Typography variant="caption" color="text.disabled">
                            Updated{" "}
                            {lastRefreshed.toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                            })}
                        </Typography>
                    )}
                    <Tooltip title="Refresh">
                        <span>
                            <IconButton
                                size="small"
                                onClick={() => void fetchAll(false)}
                                disabled={fetching}
                            >
                                {fetching ? (
                                    <CircularProgress size={18} />
                                ) : (
                                    <RefreshOutlinedIcon fontSize="small" />
                                )}
                            </IconButton>
                        </span>
                    </Tooltip>
                </Box>
            </Box>

            {error && <Alert severity="error">{error}</Alert>}

            {/* Stat cards */}
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
                <StatCard
                    icon={<PeopleOutlinedIcon />}
                    label="Users"
                    value={users.length}
                    color="#1565c0"
                    href="/admin/users"
                />
                <StatCard
                    icon={<ComputerOutlinedIcon />}
                    label="Instances"
                    value={instances.length}
                    color="#2e7d32"
                    href="/admin/instances"
                />
                <StatCard
                    icon={<PowerSettingsNewOutlinedIcon />}
                    label="Running"
                    value={runningCount}
                    color="#00695c"
                    href="/admin/instances"
                />
                <StatCard
                    icon={<ViewModuleOutlinedIcon />}
                    label="Templates"
                    value={templateCount}
                    color="#6a1b9a"
                    href="/admin/templates"
                />
            </Box>

            {/* Expiring soon */}
            <Box>
                <Box
                    sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        mb: 1,
                    }}
                >
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                        Expiring within the hour
                    </Typography>
                    {expiringSoon.length > 0 && (
                        <Button
                            size="small"
                            onClick={() => navigate("/admin/instances")}
                        >
                            View all instances
                        </Button>
                    )}
                </Box>

                {fetching ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
                        <CircularProgress size={24} />
                    </Box>
                ) : expiringSoon.length === 0 ? (
                    <Alert severity="success" icon={false}>
                        No instances expiring in the next hour.
                    </Alert>
                ) : (
                    <Paper sx={{ overflowX: "auto" }}>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Instance</TableCell>
                                    <TableCell>Owner</TableCell>
                                    <TableCell>Status</TableCell>
                                    <TableCell>Expires in</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {expiringSoon.map((instance) => {
                                    const runtime = formatRunUntil(
                                        instance.run_until,
                                    );
                                    return (
                                        <TableRow key={instance.id}>
                                            <TableCell>
                                                <Typography
                                                    variant="body2"
                                                    sx={{ fontWeight: 600 }}
                                                >
                                                    {instance.name ??
                                                        `Instance ${instance.id}`}
                                                </Typography>
                                            </TableCell>
                                            <TableCell>
                                                <Typography
                                                    variant="body2"
                                                    sx={{
                                                        fontFamily: "monospace",
                                                    }}
                                                >
                                                    {instance.owner_id}
                                                </Typography>
                                            </TableCell>
                                            <TableCell>
                                                <Chip
                                                    size="small"
                                                    label={
                                                        instance.status ??
                                                        "unknown"
                                                    }
                                                    color={
                                                        statusColor[
                                                            instance.status ??
                                                                "unknown"
                                                        ]
                                                    }
                                                />
                                            </TableCell>
                                            <TableCell>
                                                <Typography
                                                    variant="body2"
                                                    color="warning.main"
                                                    sx={{ fontWeight: 600 }}
                                                >
                                                    {runtime.text}
                                                </Typography>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </Paper>
                )}
            </Box>
        </Stack>
    );
}

// ─── Student dashboard ────────────────────────────────────────────────────────

function StudentDashboard() {
    const navigate = useNavigate();
    const [instances, setInstances] = useState<Instance[]>([]);
    const [fetching, setFetching] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState<
        Record<string, boolean>
    >({});
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error" | "info";
    } | null>(null);

    const prevRef = useRef<Instance[]>([]);
    const fetchRef = useRef<((showLoading?: boolean) => Promise<void>) | null>(
        null,
    );

    fetchRef.current = async (showLoading = true) => {
        if (showLoading) {
            setFetching(true);
            setError(null);
        }
        try {
            const res = await axios.get<Instance[]>("/api/instances");
            const next = Array.isArray(res.data) ? res.data : [];
            const prev = prevRef.current;
            const changed =
                prev.length !== next.length ||
                next.some(
                    (n, i) =>
                        prev[i]?.id !== n.id ||
                        prev[i]?.status !== n.status ||
                        prev[i]?.run_until !== n.run_until,
                );
            if (changed) {
                prevRef.current = next;
                setInstances(next);
            }
        } catch (err) {
            if (showLoading)
                setError(getErrorMessage(err, "Failed to load instances."));
        } finally {
            if (showLoading) setFetching(false);
        }
    };

    useEffect(() => {
        void fetchRef.current?.(true);
        const interval = setInterval(
            () => void fetchRef.current?.(false),
            10_000,
        );
        return () => clearInterval(interval);
    }, []);

    const setLoading = (key: string, val: boolean) =>
        setActionLoading((prev) => ({ ...prev, [key]: val }));

    const handleStart = async (instance: Instance) => {
        setLoading(`start-${instance.id}`, true);
        try {
            await axios.get(`/api/instances/${instance.id}/start`);
            setSnackbar({ message: "Instance starting…", severity: "info" });
            setTimeout(() => void fetchRef.current?.(false), 3000);
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to start instance."),
                severity: "error",
            });
        } finally {
            setLoading(`start-${instance.id}`, false);
        }
    };

    const handleStop = async (instance: Instance) => {
        setLoading(`stop-${instance.id}`, true);
        try {
            await axios.get(`/api/instances/${instance.id}/stop`);
            setSnackbar({ message: "Instance stopping…", severity: "info" });
            setTimeout(() => void fetchRef.current?.(false), 3000);
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to stop instance."),
                severity: "error",
            });
        } finally {
            setLoading(`stop-${instance.id}`, false);
        }
    };

    const handleConnect = async (instance: Instance) => {
        setLoading(`session-${instance.id}`, true);
        try {
            const res = await axios.get<{ url: string }>(
                `/api/instances/${instance.id}/session`,
            );
            if (res.data.url) window.open(res.data.url, "_blank");
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to open session."),
                severity: "error",
            });
        } finally {
            setLoading(`session-${instance.id}`, false);
        }
    };

    const handleRenew = async (instance: Instance) => {
        setLoading(`renew-${instance.id}`, true);
        try {
            await axios.get(`/api/instances/${instance.id}/renew`);
            setSnackbar({ message: "Runtime extended.", severity: "success" });
            await fetchRef.current?.(false);
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to renew instance."),
                severity: "error",
            });
        } finally {
            setLoading(`renew-${instance.id}`, false);
        }
    };

    const anyExpiring = instances.some((i) => {
        if (!i.run_until) return false;
        const ms = new Date(i.run_until).getTime() - Date.now();
        return ms > 0 && ms < 30 * 60_000;
    });

    return (
        <Stack spacing={2}>
            <Box
                sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-end",
                    gap: 2,
                }}
            >
                <Box>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                        Dashboard
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Your active lab instances
                    </Typography>
                </Box>
                <Button
                    variant="outlined"
                    size="small"
                    startIcon={<AddOutlinedIcon fontSize="small" />}
                    onClick={() => navigate("/instances")}
                >
                    Manage instances
                </Button>
            </Box>

            {error && <Alert severity="error">{error}</Alert>}

            {anyExpiring && (
                <Alert
                    severity="warning"
                    icon={<WarningAmberOutlinedIcon fontSize="small" />}
                >
                    One or more instances are expiring soon. Use the renew
                    button to extend runtime.
                </Alert>
            )}

            {fetching ? (
                <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
                    <CircularProgress />
                </Box>
            ) : instances.length === 0 ? (
                <Paper>
                    <Box
                        sx={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            py: 8,
                            gap: 2,
                        }}
                    >
                        <ComputerOutlinedIcon
                            sx={{ fontSize: 48, color: "text.disabled" }}
                        />
                        <Box sx={{ textAlign: "center" }}>
                            <Typography variant="h6" sx={{ fontWeight: 600 }}>
                                No active instances
                            </Typography>
                            <Typography
                                variant="body2"
                                color="text.secondary"
                                sx={{ mt: 0.5 }}
                            >
                                Create a virtual machine to get started with
                                your lab.
                            </Typography>
                        </Box>
                        <Button
                            variant="contained"
                            startIcon={<AddOutlinedIcon />}
                            onClick={() => navigate("/instances")}
                        >
                            Create instance
                        </Button>
                    </Box>
                </Paper>
            ) : (
                <Stack spacing={1.5}>
                    {instances.map((instance) => {
                        const runtime = formatRunUntil(instance.run_until);
                        const isAnyLoading = Object.entries(actionLoading)
                            .filter(([k]) => k.endsWith(`-${instance.id}`))
                            .some(([, v]) => v);

                        return (
                            <Paper
                                key={instance.id}
                                sx={{
                                    p: 2,
                                    borderLeft: 4,
                                    borderColor:
                                        statusBorder[
                                            instance.status ?? "unknown"
                                        ],
                                }}
                            >
                                <Box
                                    sx={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        gap: 2,
                                        flexWrap: "wrap",
                                    }}
                                >
                                    {/* Info */}
                                    <Box sx={{ minWidth: 0 }}>
                                        <Box
                                            sx={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 1,
                                                mb: 0.5,
                                            }}
                                        >
                                            <Typography
                                                variant="subtitle1"
                                                noWrap
                                                sx={{ fontWeight: 600 }}
                                            >
                                                {instance.name ??
                                                    `Instance ${instance.id}`}
                                            </Typography>
                                            <Chip
                                                size="small"
                                                label={
                                                    instance.status ?? "unknown"
                                                }
                                                color={
                                                    statusColor[
                                                        instance.status ??
                                                            "unknown"
                                                    ]
                                                }
                                            />
                                        </Box>
                                        <Typography
                                            variant="body2"
                                            color={
                                                runtime.warning
                                                    ? "warning.main"
                                                    : "text.secondary"
                                            }
                                            sx={{ fontWeight: runtime.warning ? 600 : 400 }}
                                        >
                                            {runtime.text}
                                        </Typography>
                                    </Box>

                                    {/* Actions */}
                                    <Box
                                        sx={{
                                            display: "flex",
                                            gap: 0.5,
                                            flexShrink: 0,
                                        }}
                                    >
                                        {instance.status === "running" && (
                                            <>
                                                <Tooltip title="Connect">
                                                    <span>
                                                        <IconButton
                                                            size="small"
                                                            color="primary"
                                                            onClick={() =>
                                                                void handleConnect(
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
                                                                    size={18}
                                                                />
                                                            ) : (
                                                                <OpenInNewOutlinedIcon fontSize="small" />
                                                            )}
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>
                                                <Tooltip title="Stop">
                                                    <span>
                                                        <IconButton
                                                            size="small"
                                                            onClick={() =>
                                                                void handleStop(
                                                                    instance,
                                                                )
                                                            }
                                                            disabled={
                                                                isAnyLoading
                                                            }
                                                        >
                                                            {actionLoading[
                                                                `stop-${instance.id}`
                                                            ] ? (
                                                                <CircularProgress
                                                                    size={18}
                                                                />
                                                            ) : (
                                                                <StopOutlinedIcon fontSize="small" />
                                                            )}
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
                                                            void handleStart(
                                                                instance,
                                                            )
                                                        }
                                                        disabled={isAnyLoading}
                                                    >
                                                        {actionLoading[
                                                            `start-${instance.id}`
                                                        ] ? (
                                                            <CircularProgress
                                                                size={18}
                                                            />
                                                        ) : (
                                                            <PowerSettingsNewOutlinedIcon fontSize="small" />
                                                        )}
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        )}
                                        <Tooltip title="Extend runtime">
                                            <span>
                                                <IconButton
                                                    size="small"
                                                    onClick={() =>
                                                        void handleRenew(
                                                            instance,
                                                        )
                                                    }
                                                    disabled={isAnyLoading}
                                                >
                                                    {actionLoading[
                                                        `renew-${instance.id}`
                                                    ] ? (
                                                        <CircularProgress
                                                            size={18}
                                                        />
                                                    ) : (
                                                        <UpdateOutlinedIcon fontSize="small" />
                                                    )}
                                                </IconButton>
                                            </span>
                                        </Tooltip>
                                    </Box>
                                </Box>
                            </Paper>
                        );
                    })}
                </Stack>
            )}

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

// ─── Entry point ──────────────────────────────────────────────────────────────

export default function Index() {
    const auth = useAuth();
    if (!auth) return null;
    return auth.role === "admin" ? <AdminDashboard /> : <StudentDashboard />;
}
