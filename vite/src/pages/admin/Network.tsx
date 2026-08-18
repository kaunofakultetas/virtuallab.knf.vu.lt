import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import PlayArrowOutlinedIcon from "@mui/icons-material/PlayArrowOutlined";
import type {
    GroupPeering,
    NetworkCheckStatus,
    NetworkGroupSummary,
    NetworkReadiness,
    ReconciliationAttempt,
} from "@/types/network";
import { getErrorMessage } from "@/utils/errors";

const statusColor: Record<NetworkCheckStatus, "success" | "error" | "warning" | "default"> = {
    pass: "success",
    fail: "error",
    unobserved: "warning",
    not_applicable: "default",
};

const groupStateColor: Record<
    NetworkGroupSummary["state"],
    "success" | "error" | "warning" | "info" | "default"
> = {
    planned: "default",
    creating: "info",
    active: "success",
    deleting: "warning",
    error: "error",
};

const shortRevision = (revision: string | null) =>
    revision ? revision.slice(0, 12) : "—";

export default function AdminNetwork() {
    const [readiness, setReadiness] = useState<NetworkReadiness | null>(null);
    const [groups, setGroups] = useState<NetworkGroupSummary[]>([]);
    const [peerings, setPeerings] = useState<GroupPeering[]>([]);
    const [fetching, setFetching] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dryRunning, setDryRunning] = useState(false);
    const [lastAttempt, setLastAttempt] = useState<ReconciliationAttempt | null>(null);
    const [peeringDialogOpen, setPeeringDialogOpen] = useState(false);
    const [peeringDraft, setPeeringDraft] = useState<{ a: number | ""; b: number | "" }>({
        a: "",
        b: "",
    });
    const [savingPeering, setSavingPeering] = useState(false);
    const [removingPeering, setRemovingPeering] = useState<string | null>(null);
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error";
    } | null>(null);

    const fetchData = async (showLoading = true) => {
        if (showLoading) {
            setFetching(true);
            setError(null);
        }
        try {
            const [readinessResponse, groupsResponse, peeringsResponse] = await Promise.all([
                axios.get<NetworkReadiness>("/api/network/readiness"),
                axios.get<NetworkGroupSummary[]>("/api/network/groups"),
                axios.get<GroupPeering[]>("/api/network/peerings"),
            ]);
            setReadiness(readinessResponse.data);
            setGroups(Array.isArray(groupsResponse.data) ? groupsResponse.data : []);
            setPeerings(Array.isArray(peeringsResponse.data) ? peeringsResponse.data : []);
        } catch (err) {
            if (showLoading) {
                setError(getErrorMessage(err, "Failed to load network state."));
            }
        } finally {
            if (showLoading) setFetching(false);
        }
    };

    useEffect(() => {
        void fetchData(true);
    }, []);

    // Only groups that hold an allocation can be peered: peering is rendered as
    // subnet-to-subnet rules, and a group without a subnet has no address range
    // to admit.
    const peerableGroups = useMemo(
        () => groups.filter((group) => group.subnet_cidr !== null),
        [groups],
    );

    const groupLabel = (id: number) => {
        const group = groups.find((candidate) => candidate.id === id);
        if (!group) return `Group ${id}`;
        return `${id} · ${group.owner_id}${group.vlan_tag ? ` · VLAN ${group.vlan_tag}` : ""}`;
    };

    const runDryRun = async () => {
        setDryRunning(true);
        try {
            const response = await axios.post<ReconciliationAttempt>(
                "/api/network/reconciliation-attempts",
                { apply: false, idempotency_key: `ui-${Date.now()}` },
            );
            setLastAttempt(response.data);
            setSnackbar({
                message: `Dry-run ${response.data.status} with ${response.data.checks.length} check(s).`,
                severity: response.data.status === "succeeded" ? "success" : "error",
            });
            await fetchData(false);
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to run reconciliation dry-run."),
                severity: "error",
            });
        } finally {
            setDryRunning(false);
        }
    };

    const savePeering = async () => {
        if (peeringDraft.a === "" || peeringDraft.b === "") return;
        setSavingPeering(true);
        try {
            await axios.post("/api/network/peerings", {
                group_a_id: Number(peeringDraft.a),
                group_b_id: Number(peeringDraft.b),
            });
            setPeeringDialogOpen(false);
            setPeeringDraft({ a: "", b: "" });
            setSnackbar({
                message: "Peering added. It takes effect at the next reconciliation.",
                severity: "success",
            });
            await fetchData(false);
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to add the peering."),
                severity: "error",
            });
        } finally {
            setSavingPeering(false);
        }
    };

    const removePeering = async (peering: GroupPeering) => {
        const key = `${peering.group_a_id}-${peering.group_b_id}`;
        setRemovingPeering(key);
        try {
            await axios.delete(
                `/api/network/peerings/${peering.group_a_id}/${peering.group_b_id}`,
            );
            setPeerings((current) =>
                current.filter(
                    (candidate) =>
                        candidate.group_a_id !== peering.group_a_id ||
                        candidate.group_b_id !== peering.group_b_id,
                ),
            );
            setSnackbar({
                message: "Peering removed. It takes effect at the next reconciliation.",
                severity: "success",
            });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to remove the peering."),
                severity: "error",
            });
        } finally {
            setRemovingPeering(null);
        }
    };

    const failedRequired = readiness
        ? readiness.checks.filter((check) => check.required && check.status === "fail")
        : [];

    return (
        <Stack spacing={2.5}>
            <Stack
                direction="row"
                sx={{ alignItems: "center", justifyContent: "space-between" }}
            >
                <Box>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>Network</Typography>
                    <Typography variant="body2" color="text.secondary">
                        Isolation readiness, per-group VLAN allocation, and group peering.
                    </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                    <Button
                        variant="outlined"
                        startIcon={<RefreshOutlinedIcon />}
                        onClick={() => void fetchData(true)}
                        disabled={fetching}
                    >
                        Refresh
                    </Button>
                    <Tooltip title="Observes Proxmox, the Gateway and Access without changing anything">
                        <span>
                            <Button
                                variant="contained"
                                startIcon={<PlayArrowOutlinedIcon />}
                                onClick={() => void runDryRun()}
                                disabled={dryRunning || fetching}
                            >
                                {dryRunning ? "Running…" : "Run dry-run"}
                            </Button>
                        </span>
                    </Tooltip>
                </Stack>
            </Stack>

            {error && <Alert severity="error">{error}</Alert>}

            {fetching ? (
                <Paper variant="outlined" sx={{ overflow: "hidden" }}>
                    <Box sx={{ display: "grid", placeItems: "center", minHeight: 220 }}>
                        <CircularProgress size={28} />
                    </Box>
                </Paper>
            ) : (
                <>
                    {readiness && (
                        <Paper variant="outlined" sx={{ p: 2 }}>
                            <Stack
                                direction="row"
                                spacing={1.5}
                                sx={{ flexWrap: "wrap", alignItems: "center", rowGap: 1 }}
                            >
                                <Chip
                                    label={`Mode: ${readiness.mode}`}
                                    color={readiness.mode === "active" ? "success" : "default"}
                                    size="small"
                                />
                                <Chip
                                    label={
                                        readiness.ready_for_active
                                            ? "Ready for active"
                                            : `${failedRequired.length} required check(s) failing`
                                    }
                                    color={readiness.ready_for_active ? "success" : "error"}
                                    size="small"
                                />
                                <Chip
                                    label={`Plan ${shortRevision(readiness.desired_state.plan_revision)}`}
                                    size="small"
                                    variant="outlined"
                                />
                                <Chip
                                    label={`${readiness.desired_state.projected_groups} projected group(s)`}
                                    size="small"
                                    variant="outlined"
                                />
                                <Chip
                                    label={`${readiness.desired_state.linked_instances} linked instance(s)`}
                                    size="small"
                                    variant="outlined"
                                />
                            </Stack>
                        </Paper>
                    )}

                    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
                        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                Readiness checks
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                Independent read-only observations. Isolated provisioning is
                                refused while any required check fails.
                            </Typography>
                        </Box>
                        <Divider />
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Check</TableCell>
                                    <TableCell>Status</TableCell>
                                    <TableCell>Required</TableCell>
                                    <TableCell>Detail</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {(readiness?.checks ?? []).map((check) => (
                                    <TableRow key={check.key} hover>
                                        <TableCell sx={{ fontFamily: "monospace" }}>
                                            {check.key}
                                        </TableCell>
                                        <TableCell>
                                            <Chip
                                                label={check.status}
                                                color={statusColor[check.status] ?? "default"}
                                                size="small"
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <Typography variant="body2" color="text.secondary">
                                                {check.required ? "required" : "optional"}
                                            </Typography>
                                        </TableCell>
                                        <TableCell>
                                            <Typography variant="body2" color="text.secondary">
                                                {check.detail}
                                            </Typography>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </Paper>

                    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
                        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                Network groups
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                One VLAN and subnet per owner and lab profile. A group keeps its
                                allocation until every VM on it is gone.
                            </Typography>
                        </Box>
                        <Divider />
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>ID</TableCell>
                                    <TableCell>Owner</TableCell>
                                    <TableCell>Profile</TableCell>
                                    <TableCell>State</TableCell>
                                    <TableCell>VLAN</TableCell>
                                    <TableCell>Subnet</TableCell>
                                    <TableCell align="right">VMs</TableCell>
                                    <TableCell>Applied</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {groups.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={8}>
                                            <Typography variant="body2" color="text.secondary">
                                                No network groups yet.
                                            </Typography>
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    groups.map((group) => (
                                        <TableRow key={group.id} hover>
                                            <TableCell>{group.id}</TableCell>
                                            <TableCell>{group.owner_id}</TableCell>
                                            <TableCell>{group.profile_name}</TableCell>
                                            <TableCell>
                                                <Tooltip title={group.last_error ?? ""}>
                                                    <Chip
                                                        label={group.state}
                                                        color={groupStateColor[group.state]}
                                                        size="small"
                                                    />
                                                </Tooltip>
                                            </TableCell>
                                            <TableCell>{group.vlan_tag ?? "—"}</TableCell>
                                            <TableCell sx={{ fontFamily: "monospace" }}>
                                                {group.subnet_cidr ?? "—"}
                                            </TableCell>
                                            <TableCell align="right">
                                                {group.instance_count}
                                            </TableCell>
                                            <TableCell sx={{ fontFamily: "monospace" }}>
                                                {shortRevision(group.applied_revision)}
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </Paper>

                    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
                        <Stack
                            direction="row"
                            sx={{
                                alignItems: "center",
                                justifyContent: "space-between",
                                px: 2,
                                pt: 2,
                                pb: 1,
                            }}
                        >
                            <Box>
                                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                    Group peering
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                    Deny-by-default. A peering opens traffic in both directions and
                                    takes effect at the next reconciliation.
                                </Typography>
                            </Box>
                            <Button
                                size="small"
                                variant="contained"
                                startIcon={<AddOutlinedIcon />}
                                onClick={() => setPeeringDialogOpen(true)}
                                disabled={peerableGroups.length < 2}
                            >
                                Add peering
                            </Button>
                        </Stack>
                        <Divider />
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Group A</TableCell>
                                    <TableCell>Group B</TableCell>
                                    <TableCell align="right">Actions</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {peerings.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={3}>
                                            <Typography variant="body2" color="text.secondary">
                                                {peerableGroups.length < 2
                                                    ? "At least two allocated groups are needed before they can be peered."
                                                    : "No peerings. Groups cannot reach each other."}
                                            </Typography>
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    peerings.map((peering) => {
                                        const key = `${peering.group_a_id}-${peering.group_b_id}`;
                                        return (
                                            <TableRow key={key} hover>
                                                <TableCell>
                                                    {groupLabel(peering.group_a_id)}
                                                </TableCell>
                                                <TableCell>
                                                    {groupLabel(peering.group_b_id)}
                                                </TableCell>
                                                <TableCell align="right">
                                                    <IconButton
                                                        size="small"
                                                        onClick={() => void removePeering(peering)}
                                                        disabled={removingPeering === key}
                                                    >
                                                        <DeleteOutlinedIcon fontSize="small" />
                                                    </IconButton>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })
                                )}
                            </TableBody>
                        </Table>
                    </Paper>

                    {lastAttempt && (
                        <Paper variant="outlined" sx={{ p: 2 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                Last dry-run
                            </Typography>
                            <Stack
                                direction="row"
                                spacing={1.5}
                                sx={{ mt: 1, flexWrap: "wrap", rowGap: 1 }}
                            >
                                <Chip label={`Attempt ${lastAttempt.id}`} size="small" variant="outlined" />
                                <Chip
                                    label={lastAttempt.status}
                                    color={lastAttempt.status === "succeeded" ? "success" : "error"}
                                    size="small"
                                />
                                <Chip label={`phase ${lastAttempt.phase}`} size="small" variant="outlined" />
                                <Chip
                                    label={`${lastAttempt.checks.length} check(s)`}
                                    size="small"
                                    variant="outlined"
                                />
                                <Chip
                                    label={`${lastAttempt.actions.length} proposed action(s)`}
                                    size="small"
                                    variant="outlined"
                                />
                            </Stack>
                            {lastAttempt.error_detail && (
                                <Alert severity="error" sx={{ mt: 1.5 }}>
                                    {lastAttempt.error_detail}
                                </Alert>
                            )}
                        </Paper>
                    )}
                </>
            )}

            <Dialog
                open={peeringDialogOpen}
                onClose={() => setPeeringDialogOpen(false)}
                fullWidth
                maxWidth="sm"
            >
                <DialogTitle>Add group peering</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <Typography variant="body2" color="text.secondary">
                            Peering is undirected: either group may initiate traffic to the other.
                            It is written to the database here and rendered onto the Gateway and
                            the VMs at the next reconciliation.
                        </Typography>
                        <FormControl fullWidth>
                            <InputLabel id="peering-a">Group A</InputLabel>
                            <Select
                                labelId="peering-a"
                                label="Group A"
                                value={peeringDraft.a}
                                onChange={(event) =>
                                    setPeeringDraft((current) => ({
                                        ...current,
                                        a: Number(event.target.value),
                                    }))
                                }
                            >
                                {peerableGroups.map((group) => (
                                    <MenuItem key={group.id} value={group.id}>
                                        {groupLabel(group.id)}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <FormControl fullWidth>
                            <InputLabel id="peering-b">Group B</InputLabel>
                            <Select
                                labelId="peering-b"
                                label="Group B"
                                value={peeringDraft.b}
                                onChange={(event) =>
                                    setPeeringDraft((current) => ({
                                        ...current,
                                        b: Number(event.target.value),
                                    }))
                                }
                            >
                                {peerableGroups
                                    .filter((group) => group.id !== peeringDraft.a)
                                    .map((group) => (
                                        <MenuItem key={group.id} value={group.id}>
                                            {groupLabel(group.id)}
                                        </MenuItem>
                                    ))}
                            </Select>
                        </FormControl>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPeeringDialogOpen(false)}>Cancel</Button>
                    <Button
                        variant="contained"
                        onClick={() => void savePeering()}
                        disabled={
                            savingPeering ||
                            peeringDraft.a === "" ||
                            peeringDraft.b === "" ||
                            peeringDraft.a === peeringDraft.b
                        }
                    >
                        {savingPeering ? "Adding…" : "Add peering"}
                    </Button>
                </DialogActions>
            </Dialog>

            <Snackbar
                open={snackbar !== null}
                autoHideDuration={5000}
                onClose={() => setSnackbar(null)}
                anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
            >
                <Alert
                    severity={snackbar?.severity ?? "success"}
                    onClose={() => setSnackbar(null)}
                    variant="filled"
                >
                    {snackbar?.message}
                </Alert>
            </Snackbar>
        </Stack>
    );
}
