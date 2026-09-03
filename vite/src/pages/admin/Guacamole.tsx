// -----------------------------------------------------------
//  [*] Admin — Guacamole connections
//
//  Read-only table of every connection registered in
//  Guacamole (GET /api/guacamole/connections): protocol,
//  live session count, connection limits, last activity.
//  Manual refresh only — this page is for spot checks, not
//  monitoring.
//
//  Used by:
//    - router.tsx — route /admin/guacamole
// -----------------------------------------------------------

import { useEffect, useState } from "react";
import axios from "axios";
import { getErrorMessage } from "@/utils/errors";
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
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Tooltip from "@mui/material/Tooltip";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";

// The flattened row shape the backend's connections route answers with.
interface GuacConnection {
    identifier: string;
    name: string;
    parentIdentifier: string;
    protocol: string;
    activeConnections: number;
    lastActive: number | null;
    maxConnections: string | null;
    maxConnectionsPerUser: string | null;
}


export default function AdminGuacamole() {
    const [connections, setConnections] = useState<GuacConnection[]>([]);
    const [fetching, setFetching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);


    const fetchConnections = async () => {
        setFetching(true);
        setError(null);
        try {
            const res = await axios.get<GuacConnection[]>(
                "/api/guacamole/connections",
            );
            setConnections(Array.isArray(res.data) ? res.data : []);
            setLastRefreshed(new Date());
        } catch (err) {
            setError(getErrorMessage(err, "Failed to load Guacamole connections."));
        } finally {
            setFetching(false);
        }
    };


    useEffect(() => {
        void fetchConnections();
    }, []);


    const formatLastActive = (ts: number | null): string => {
        if (!ts) return "—";
        return new Date(ts).toLocaleString();
    };


    return (
        <Stack spacing={2}>
            {/* Header row — title and the manual refresh */}
            <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
                <Box>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                        Guacamole Connections
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Read-only view of all registered Guacamole connections.
                        {lastRefreshed && (
                            <> Last refreshed at {lastRefreshed.toLocaleTimeString()}.</>
                        )}
                    </Typography>
                </Box>
                <Button
                    variant="outlined"
                    startIcon={<RefreshOutlinedIcon fontSize="small" />}
                    onClick={() => void fetchConnections()}
                    disabled={fetching}
                >
                    Refresh
                </Button>
            </Box>

            {error && <Alert severity="error">{error}</Alert>}

            {/* The table — spinner row, empty row, or the connections */}
            <Paper sx={{ overflowX: "auto" }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>ID</TableCell>
                            <TableCell>Name (Instance ID)</TableCell>
                            <TableCell>Protocol</TableCell>
                            <TableCell>Active</TableCell>
                            <TableCell>Max / User</TableCell>
                            <TableCell>Last Active</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {fetching ? (
                            <TableRow>
                                <TableCell colSpan={6}>
                                    <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
                                        <CircularProgress size={24} />
                                    </Box>
                                </TableCell>
                            </TableRow>
                        ) : connections.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6}>
                                    <Typography
                                        variant="body2"
                                        color="text.secondary"
                                        sx={{ py: 2 }}
                                    >
                                        No connections registered in Guacamole.
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ) : (
                            connections.map((conn) => (
                                <TableRow key={conn.identifier}>
                                    <TableCell>
                                        <Typography
                                            variant="caption"
                                            sx={{ fontFamily: "monospace", color: "text.secondary" }}
                                        >
                                            {conn.identifier}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                            {conn.name}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        <Chip
                                            size="small"
                                            label={conn.protocol.toUpperCase()}
                                            variant="outlined"
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <Tooltip
                                            title={
                                                conn.activeConnections > 0
                                                    ? `${conn.activeConnections} active session(s)`
                                                    : "No active sessions"
                                            }
                                        >
                                            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                                <FiberManualRecordIcon
                                                    sx={{
                                                        fontSize: 10,
                                                        color: conn.activeConnections > 0
                                                            ? "success.main"
                                                            : "text.disabled",
                                                    }}
                                                />
                                                <Typography variant="body2">
                                                    {conn.activeConnections}
                                                </Typography>
                                            </Box>
                                        </Tooltip>
                                    </TableCell>
                                    <TableCell>
                                        <Typography variant="body2" color="text.secondary">
                                            {conn.maxConnections || "∞"} / {conn.maxConnectionsPerUser || "∞"}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        <Typography variant="body2" color="text.secondary">
                                            {formatLastActive(conn.lastActive)}
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
