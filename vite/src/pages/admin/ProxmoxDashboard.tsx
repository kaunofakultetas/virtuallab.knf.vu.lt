// -----------------------------------------------------------
//  [*] Admin — Proxmox running instances
//
//  View-only live dashboard of running Proxmox VMs
//  (GET /api/instances/all/running), auto-refreshing every
//  5 s. Background refreshes neither flash the spinner nor
//  surface errors — a transient poll failure just leaves
//  the last good data on screen.
//
//  Split into (root component first):
//
//    AdminProxmoxDashboard — the page (default export)
//    formatMemory          — bytes → "x.xx / y.yy GiB"
//    formatUptime          — seconds → "1d 2h 3m"
//
//  Used by:
//    - router.tsx — route /admin/proxmox-dashboard
// -----------------------------------------------------------

import { useEffect, useState } from "react";
import axios from "axios";
import { getErrorMessage } from "@/utils/errors";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";

// The raw Proxmox VM listing fields this table renders.
interface RunningProxmoxVm {
    vmid: number;
    name: string | null;
    status: "running" | "stopped";
    cpus: number | null;
    cpu: number | null;
    mem: number | null;
    maxmem: number | null;
    uptime: number | null;
    tags: string | null;
}


export default function AdminProxmoxDashboard() {
    const [instances, setInstances] = useState<RunningProxmoxVm[]>([]);
    const [fetching, setFetching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);


    // showLoading=false is the 5 s background poll: no spinner, no error
    // banner — stale data beats a flickering table.
    const fetchRunningInstances = async (showLoading = true) => {
        if (showLoading) {
            setFetching(true);
            setError(null);
        }

        try {
            const res = await axios.get<RunningProxmoxVm[]>(
                "/api/instances/all/running",
            );
            const data = Array.isArray(res.data) ? res.data : [];
            setInstances(data.sort((a, b) => a.vmid - b.vmid));
            setLastRefreshed(new Date());
        } catch (err) {
            if (showLoading) {
                setError(
                    getErrorMessage(
                        err,
                        "Failed to load running Proxmox instances.",
                    ),
                );
            }
        } finally {
            if (showLoading) setFetching(false);
        }
    };


    useEffect(() => {
        void fetchRunningInstances(true);

        const interval = setInterval(() => {
            void fetchRunningInstances(false);
        }, 5_000);

        return () => clearInterval(interval);
    }, []);


    return (
        <Stack spacing={2}>
            <Box>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                    Proxmox Running Instances
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    View-only live dashboard of currently running Proxmox VMs.
                    {lastRefreshed && (
                        <> Last refreshed at {lastRefreshed.toLocaleTimeString()}.</>
                    )}
                </Typography>
            </Box>

            {error && <Alert severity="error">{error}</Alert>}

            <Paper sx={{ overflowX: "auto" }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>VMID</TableCell>
                            <TableCell>Name</TableCell>
                            <TableCell>Status</TableCell>
                            <TableCell>vCPU</TableCell>
                            <TableCell>CPU %</TableCell>
                            <TableCell>Memory</TableCell>
                            <TableCell>Uptime</TableCell>
                            <TableCell>Tags</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {fetching ? (
                            <TableRow>
                                <TableCell colSpan={8}>
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
                                <TableCell colSpan={8}>
                                    <Typography
                                        variant="body2"
                                        color="text.secondary"
                                        sx={{ py: 2 }}
                                    >
                                        No running instances found.
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ) : (
                            instances.map((vm) => (
                                <TableRow key={vm.vmid}>
                                    <TableCell>{vm.vmid}</TableCell>
                                    <TableCell>
                                        <Typography
                                            variant="body2"
                                            sx={{ fontWeight: 600 }}
                                        >
                                            {vm.name ?? "—"}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        <Chip
                                            size="small"
                                            color="success"
                                            label={vm.status.toUpperCase()}
                                            variant="outlined"
                                        />
                                    </TableCell>
                                    <TableCell>{vm.cpus ?? "—"}</TableCell>
                                    <TableCell>
                                        {typeof vm.cpu === "number"
                                            ? `${(vm.cpu * 100).toFixed(1)}%`
                                            : "—"}
                                    </TableCell>
                                    <TableCell>
                                        {formatMemory(vm.mem, vm.maxmem)}
                                    </TableCell>
                                    <TableCell>{formatUptime(vm.uptime)}</TableCell>
                                    <TableCell>
                                        <Typography
                                            variant="caption"
                                            color="text.secondary"
                                        >
                                            {vm.tags || "—"}
                                        </Typography>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </Paper>
        </Stack>
    );
}


// Bytes → "used / max GiB", or an em dash when either side is unknown.
function formatMemory(used: number | null, max: number | null): string {
    if (typeof used !== "number" || typeof max !== "number" || max <= 0) {
        return "—";
    }

    const usedGiB = used / (1024 ** 3);
    const maxGiB = max / (1024 ** 3);
    return `${usedGiB.toFixed(2)} / ${maxGiB.toFixed(2)} GiB`;
}


// Seconds → the largest two meaningful units.
function formatUptime(uptimeSec: number | null): string {
    if (typeof uptimeSec !== "number" || uptimeSec < 0) return "—";

    const days = Math.floor(uptimeSec / 86_400);
    const hours = Math.floor((uptimeSec % 86_400) / 3_600);
    const minutes = Math.floor((uptimeSec % 3_600) / 60);

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
