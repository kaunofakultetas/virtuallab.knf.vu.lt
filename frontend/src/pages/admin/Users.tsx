import { useEffect, useState } from "react";
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
import TableSortLabel from "@mui/material/TableSortLabel";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import type { SelectChangeEvent } from "@mui/material/Select";
import InputLabel from "@mui/material/InputLabel";
import FormControl from "@mui/material/FormControl";
import type { User, CreateUserResponse } from "@/types/users";
import { getErrorMessage } from "@/utils/errors";

const roleOptions = [
    { value: "student", label: "Student" },
    { value: "admin", label: "Admin" },
];

export default function Users() {
    const [users, setUsers] = useState<User[]>([]);
    const [fetching, setFetching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error" | "info";
    } | null>(null);

    const [createOpen, setCreateOpen] = useState(false);
    const [createBulkIds, setCreateBulkIds] = useState("");
    const [createPassword, setCreatePassword] = useState("");
    const [createLoading, setCreateLoading] = useState(false);
    const [createResults, setCreateResults] = useState<CreateUserResponse[]>(
        [],
    );
    const [showResults, setShowResults] = useState(false);

    const [editOpen, setEditOpen] = useState(false);
    const [editUser, setEditUser] = useState<User | null>(null);
    const [editPassword, setEditPassword] = useState("");
    const [editRole, setEditRole] = useState("");
    const [editLoading, setEditLoading] = useState(false);
    const [editGeneratedPassword, setEditGeneratedPassword] = useState<
        string | null
    >(null);

    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
    const [passwordRevealed, setPasswordRevealed] = useState(false);

    useEffect(() => {
        void fetchUsers();
    }, []);

    const fetchUsers = async () => {
        setFetching(true);
        setError(null);
        try {
            const response = await axios.get<User[]>("/api/auth/users");
            setUsers(Array.isArray(response.data) ? response.data : []);
        } catch (err) {
            setError(getErrorMessage(err, "Failed to load users."));
        } finally {
            setFetching(false);
        }
    };

    const handleCreateClose = () => {
        setCreateOpen(false);
        setCreateBulkIds("");
        setCreatePassword("");
        setCreateResults([]);
        setShowResults(false);
    };

    const parseBulkIds = (raw: string): string[] =>
        raw
            .split(/[\n,;]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

    const handleCreate = async () => {
        const ids = parseBulkIds(createBulkIds);
        if (ids.length === 0) return;
        setCreateLoading(true);
        try {
            const payload: { users: { vu_id: string; password?: string }[] } = {
                users: ids.map((vu_id) => ({
                    vu_id,
                    ...(createPassword.trim()
                        ? { password: createPassword.trim() }
                        : {}),
                })),
            };
            const response = await axios.post<CreateUserResponse[]>(
                "/api/auth/users",
                payload,
            );
            setCreateResults(response.data);
            setShowResults(true);
            await fetchUsers();
            const successCount = response.data.filter((r) => r.success).length;
            setSnackbar({
                message: `${successCount} user(s) created successfully.`,
                severity: "success",
            });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to create user(s)."),
                severity: "error",
            });
        } finally {
            setCreateLoading(false);
        }
    };

    const handleDelete = async (user: User) => {
        if (!window.confirm(`Delete user "${user.vu_id}"?`)) return;
        setDeletingId(user.vu_id);
        try {
            await axios.delete(`/api/auth/users/${user.vu_id}`);
            setUsers((prev) => prev.filter((u) => u.vu_id !== user.vu_id));
            setSnackbar({ message: "User deleted.", severity: "success" });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to delete user."),
                severity: "error",
            });
        } finally {
            setDeletingId(null);
        }
    };

    const sortedUsers = [...users].sort((a, b) => {
        const aTime = a.last_login ? new Date(a.last_login).getTime() : 0;
        const bTime = b.last_login ? new Date(b.last_login).getTime() : 0;
        return sortOrder === "desc" ? bTime - aTime : aTime - bTime;
    });

    const openEditDialog = (user: User) => {
        setEditUser(user);
        setEditRole(user.role ?? "student");
        setEditPassword("");
        setEditGeneratedPassword(null);
        setPasswordRevealed(false);
        setEditOpen(true);
    };

    const handleEditClose = () => {
        setEditOpen(false);
        setEditUser(null);
        setEditGeneratedPassword(null);
        setPasswordRevealed(false);
    };

    const handleEdit = async () => {
        if (!editUser) return;
        setEditLoading(true);
        try {
            const body: { password?: string; role?: string } = {};
            if (editPassword.trim()) body.password = editPassword.trim();
            if (editRole) body.role = editRole;

            if (Object.keys(body).length === 0) {
                setSnackbar({
                    message: "Nothing to update.",
                    severity: "info",
                });
                handleEditClose();
                return;
            }

            const response = await axios.patch<{
                vu_id: string;
                role: string;
            }>(`/api/auth/users/${editUser.vu_id}`, body);

            setUsers((prev) =>
                prev.map((u) =>
                    u.vu_id === editUser.vu_id
                        ? { ...u, role: response.data.role }
                        : u,
                ),
            );

            if (editPassword.trim()) {
                setEditGeneratedPassword(editPassword.trim());
            }

            setSnackbar({
                message: "User updated successfully.",
                severity: "success",
            });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to update user."),
                severity: "error",
            });
        } finally {
            setEditLoading(false);
        }
    };

    const handleRoleChange = (e: SelectChangeEvent) => {
        setEditRole(e.target.value);
    };

    const handleCopyPassword = async (password: string, vu_id: string) => {
        try {
            await navigator.clipboard.writeText(password);
            setCopiedId(vu_id);
            setTimeout(() => setCopiedId(null), 2000);
            setSnackbar({
                message: "Password copied to clipboard.",
                severity: "info",
            });
        } catch {
            setSnackbar({
                message: "Failed to copy password.",
                severity: "error",
            });
        }
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
                        Users
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Manage virtual lab users and access.
                    </Typography>
                </Box>
                <Button
                    variant="contained"
                    startIcon={<AddOutlinedIcon fontSize="small" />}
                    onClick={() => setCreateOpen(true)}
                >
                    New user
                </Button>
            </Box>

            {error && <Alert severity="error">{error}</Alert>}

            <Paper sx={{ overflowX: "auto" }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>VU ID</TableCell>
                            <TableCell>Role</TableCell>
                            <TableCell>
                                <TableSortLabel
                                    active
                                    direction={sortOrder}
                                    onClick={() =>
                                        setSortOrder((o) =>
                                            o === "desc" ? "asc" : "desc",
                                        )
                                    }
                                >
                                    Last Login
                                </TableSortLabel>
                            </TableCell>
                            <TableCell align="right">Actions</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {fetching ? (
                            <TableRow>
                                <TableCell colSpan={4}>
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
                        ) : users.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={4}>
                                    <Typography
                                        variant="body2"
                                        color="text.secondary"
                                        sx={{ py: 2 }}
                                    >
                                        No users found. Click "New user" to
                                        create one.
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ) : (
                            sortedUsers.map((user) => (
                                <TableRow key={user.vu_id}>
                                    <TableCell>
                                        <Typography
                                            variant="body2"
                                            sx={{ fontWeight: 600 }}
                                        >
                                            {user.vu_id}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        <Chip
                                            size="small"
                                            label={user.role ?? "student"}
                                            color={
                                                user.role === "admin"
                                                    ? "error"
                                                    : "default"
                                            }
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <Typography
                                            variant="body2"
                                            color="text.secondary"
                                        >
                                            {user.last_login
                                                ? new Date(
                                                      user.last_login,
                                                  ).toLocaleString()
                                                : "—"}
                                        </Typography>
                                    </TableCell>
                                    <TableCell align="right">
                                        <Tooltip title="Edit">
                                            <IconButton
                                                size="small"
                                                onClick={() =>
                                                    openEditDialog(user)
                                                }
                                            >
                                                <EditOutlinedIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Delete">
                                            <span>
                                                <IconButton
                                                    size="small"
                                                    onClick={() =>
                                                        handleDelete(user)
                                                    }
                                                    disabled={
                                                        deletingId ===
                                                        user.vu_id
                                                    }
                                                >
                                                    <DeleteOutlinedIcon fontSize="small" />
                                                </IconButton>
                                            </span>
                                        </Tooltip>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </Paper>

            {/* Create User Dialog */}
            <Dialog
                open={createOpen}
                onClose={handleCreateClose}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>Create user(s)</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField
                            label="VU IDs"
                            value={createBulkIds}
                            onChange={(e) => setCreateBulkIds(e.target.value)}
                            fullWidth
                            autoFocus
                            multiline
                            minRows={4}
                            maxRows={10}
                            placeholder={
                                "Enter one ID per line, e.g.:\n1234567\n2345678\n3456789"
                            }
                            helperText={`One ID per line, or separated by commas/semicolons. ${parseBulkIds(createBulkIds).length > 0 ? `${parseBulkIds(createBulkIds).length} ID(s) detected.` : ""}`}
                        />
                        <TextField
                            label="Password (optional)"
                            type="password"
                            value={createPassword}
                            onChange={(e) => setCreatePassword(e.target.value)}
                            fullWidth
                            helperText="Leave empty to auto-generate passwords"
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button
                        onClick={handleCreateClose}
                        disabled={createLoading}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="contained"
                        onClick={handleCreate}
                        disabled={
                            parseBulkIds(createBulkIds).length === 0 ||
                            createLoading
                        }
                    >
                        {createLoading ? (
                            <CircularProgress size={20} />
                        ) : (
                            `Create ${parseBulkIds(createBulkIds).length > 1 ? `${parseBulkIds(createBulkIds).length} users` : "user"}`
                        )}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Create Results Dialog */}
            <Dialog
                open={showResults}
                onClose={() => setShowResults(false)}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>Creation results</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        {createResults.map((result) => (
                            <Paper key={result.vu_id} sx={{ p: 2 }}>
                                <Typography
                                    variant="body2"
                                    sx={{ fontWeight: 600 }}
                                >
                                    VU ID: {result.vu_id}
                                </Typography>
                                {result.success ? (
                                    <Stack
                                        direction="row"
                                        spacing={1}
                                        sx={{ mt: 0.5, alignItems: "center" }}
                                    >
                                        <Chip
                                            size="small"
                                            label="Success"
                                            color="success"
                                        />
                                        {result.data?.password && (
                                            <>
                                                <Typography
                                                    variant="body2"
                                                    sx={{
                                                        fontFamily: "monospace",
                                                    }}
                                                >
                                                    {result.data.password}
                                                </Typography>
                                                <Tooltip
                                                    title={
                                                        copiedId ===
                                                        result.vu_id
                                                            ? "Copied!"
                                                            : "Copy password"
                                                    }
                                                >
                                                    <IconButton
                                                        size="small"
                                                        onClick={() =>
                                                            result.data
                                                                ?.password &&
                                                            handleCopyPassword(
                                                                result.data
                                                                    .password,
                                                                result.vu_id,
                                                            )
                                                        }
                                                    >
                                                        <ContentCopyOutlinedIcon fontSize="small" />
                                                    </IconButton>
                                                </Tooltip>
                                            </>
                                        )}
                                    </Stack>
                                ) : (
                                    <Chip
                                        size="small"
                                        label="Failed"
                                        color="error"
                                        sx={{ mt: 0.5 }}
                                    />
                                )}
                            </Paper>
                        ))}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button
                        startIcon={<ContentCopyOutlinedIcon fontSize="small" />}
                        onClick={() => {
                            const text = createResults
                                .filter((r) => r.success)
                                .map((r) => {
                                    const pw =
                                        r.data?.password ?? createPassword.trim();
                                    return pw
                                        ? `${r.vu_id}:${pw}`
                                        : r.vu_id;
                                })
                                .join("\n");
                            navigator.clipboard.writeText(text).then(() => {
                                setSnackbar({
                                    message: "Copied all credentials.",
                                    severity: "info",
                                });
                            });
                        }}
                        disabled={createResults.filter((r) => r.success).length === 0}
                    >
                        Copy all
                    </Button>
                    <Button
                        onClick={() => setShowResults(false)}
                        variant="contained"
                    >
                        Close
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Edit User Dialog */}
            <Dialog
                open={editOpen}
                onClose={handleEditClose}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>Edit user: {editUser?.vu_id}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <FormControl fullWidth>
                            <InputLabel>Role</InputLabel>
                            <Select
                                value={editRole}
                                label="Role"
                                onChange={handleRoleChange}
                            >
                                {roleOptions.map((opt) => (
                                    <MenuItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <TextField
                            label="New password (optional)"
                            type="password"
                            value={editPassword}
                            onChange={(e) => setEditPassword(e.target.value)}
                            fullWidth
                            helperText="Leave empty to keep current password"
                        />
                        {editGeneratedPassword && (
                            <Paper sx={{ p: 2 }}>
                                <Typography
                                    variant="body2"
                                    sx={{ fontWeight: 600 }}
                                >
                                    New password:
                                </Typography>
                                <Stack
                                    direction="row"
                                    spacing={1}
                                    sx={{ mt: 0.5, alignItems: "center" }}
                                >
                                    <Tooltip
                                        title={
                                            passwordRevealed
                                                ? "Click to hide"
                                                : "Click to reveal"
                                        }
                                    >
                                        <Typography
                                            variant="body2"
                                            sx={{
                                                fontFamily: "monospace",
                                                cursor: "pointer",
                                                userSelect: passwordRevealed
                                                    ? "text"
                                                    : "none",
                                                letterSpacing: passwordRevealed
                                                    ? undefined
                                                    : "0.15em",
                                            }}
                                            onClick={() =>
                                                setPasswordRevealed((v) => !v)
                                            }
                                        >
                                            {passwordRevealed
                                                ? editGeneratedPassword
                                                : "••••••••"}
                                        </Typography>
                                    </Tooltip>
                                    <Tooltip title="Copy password">
                                        <IconButton
                                            size="small"
                                            onClick={() =>
                                                handleCopyPassword(
                                                    editGeneratedPassword!,
                                                    editUser!.vu_id,
                                                )
                                            }
                                        >
                                            <ContentCopyOutlinedIcon fontSize="small" />
                                        </IconButton>
                                    </Tooltip>
                                </Stack>
                            </Paper>
                        )}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleEditClose} disabled={editLoading}>
                        Cancel
                    </Button>
                    <Button
                        variant="contained"
                        onClick={handleEdit}
                        disabled={editLoading}
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
                {snackbar && (
                    <Alert
                        onClose={() => setSnackbar(null)}
                        severity={snackbar.severity}
                        sx={{ width: "100%" }}
                    >
                        {snackbar.message}
                    </Alert>
                )}
            </Snackbar>
        </Stack>
    );
}

