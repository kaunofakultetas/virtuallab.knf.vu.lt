import { useMemo, useState } from "react";
import { useLoaderData, useNavigate } from "react-router-dom";
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
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import type { Template } from "@/types/templates";
import { TemplateFormDialog } from "@/components/templates/TemplateFormDialog";
import type { TemplateFormValues } from "@/components/templates/TemplateFormDialog";
import {
    extractTemplate,
    extractTemplates,
    getErrorMessage,
    getResponseMessage,
} from "@/utils/templates";

const templateTypeOptions = ["student_vm", "lab_vm"];

const emptyFormValues: TemplateFormValues = {
    name: "",
    type: "",
    proxmox_id: "",
    description: "",
    visible_to_students: false,
    connection_type: "guacamole",
    guac_username_mode: "creatorId",
    guac_username_custom: "",
    guac_password_mode: "creatorId",
    guac_password_custom: "",
    ssh_port: "",
    ssh_username_mode: "userId",
    ssh_username_custom: "",
    ssh_password_mode: "userId",
    ssh_password_custom: "",
    web_port: "",
    web_protocol: "https",
};

export default function Templates() {
    const navigate = useNavigate();
    const initialTemplates = useLoaderData<Template[]>();
    const [templates, setTemplates] = useState<Template[]>(initialTemplates);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error" | "info";
    } | null>(null);

    const [createOpen, setCreateOpen] = useState(false);
    const [createValues, setCreateValues] =
        useState<TemplateFormValues>(emptyFormValues);
    const [createLoading, setCreateLoading] = useState(false);

    const [editOpen, setEditOpen] = useState(false);
    const [editValues, setEditValues] =
        useState<TemplateFormValues>(emptyFormValues);
    const [editLoading, setEditLoading] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<Template | null>(
        null,
    );

    const [validatingId, setValidatingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const isCreateValid = useMemo(
        () =>
            Boolean(
                createValues.name.trim() &&
                createValues.type.trim() &&
                createValues.proxmox_id.trim(),
            ),
        [createValues],
    );

    const isEditValid = useMemo(
        () =>
            Boolean(
                editValues.name.trim() &&
                editValues.type.trim() &&
                editValues.proxmox_id.trim(),
            ),
        [editValues],
    );

    const refreshTemplates = async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await axios.get("/api/templates");
            const extracted = extractTemplates(response.data);
            if (!extracted) {
                setTemplates([]);
                setError("Unexpected response from server.");
            } else {
                setTemplates(extracted);
            }
        } catch (err) {
            setError(getErrorMessage(err, "Failed to load templates."));
        } finally {
            setLoading(false);
        }
    };

    const handleCreateClose = () => {
        setCreateOpen(false);
        setCreateValues(emptyFormValues);
    };

    const handleEditClose = () => {
        setEditOpen(false);
        setEditingTemplate(null);
    };

    const buildConnectionConfig = (values: TemplateFormValues) => {
        const cfg: Record<string, unknown> = {};
        const resolveCredential = (mode: string, custom: string) =>
            mode === "custom" ? custom : mode;
        if (values.connection_type === "guacamole") {
            cfg.username = resolveCredential(values.guac_username_mode, values.guac_username_custom);
            cfg.password = resolveCredential(values.guac_password_mode, values.guac_password_custom);
        }
        if (values.connection_type === "ssh") {
            cfg.username = resolveCredential(values.ssh_username_mode, values.ssh_username_custom);
            cfg.password = resolveCredential(values.ssh_password_mode, values.ssh_password_custom);
            if (values.ssh_port) cfg.port = parseInt(values.ssh_port);
        }
        if (values.connection_type === "web") {
            cfg.port = values.web_port ? parseInt(values.web_port) : 443;
            cfg.protocol = values.web_protocol || "https";
        }
        return cfg;
    };

    const handleCreate = async () => {
        if (!isCreateValid) {
            return;
        }
        setCreateLoading(true);
        try {
            const payload = {
                name: createValues.name.trim(),
                type: createValues.type.trim(),
                proxmox_id: createValues.proxmox_id.trim(),
                description: createValues.description.trim(),
                connection_type: createValues.connection_type,
                connection_config: buildConnectionConfig(createValues),
            };
            const response = await axios.post("/api/templates", payload);
            const createdTemplate = extractTemplate(response.data);
            if (createdTemplate) {
                setTemplates((prev) => [createdTemplate, ...prev]);
            } else {
                await refreshTemplates();
            }
            setSnackbar({ message: "Template created.", severity: "success" });
            handleCreateClose();
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to create template."),
                severity: "error",
            });
        } finally {
            setCreateLoading(false);
        }
    };

    const handleEdit = async () => {
        if (!editingTemplate || !isEditValid) {
            return;
        }
        setEditLoading(true);
        try {
            const payload = {
                name: editValues.name.trim(),
                type: editValues.type.trim(),
                proxmox_id: editValues.proxmox_id.trim(),
                description: editValues.description.trim(),
                visible_to_students: editValues.visible_to_students,
                connection_type: editValues.connection_type,
                connection_config: buildConnectionConfig(editValues),
            };
            const response = await axios.patch(
                `/api/templates/${editingTemplate.id}`,
                payload,
            );
            const updatedTemplate = extractTemplate(response.data);
            setTemplates((prev) =>
                prev.map((template) =>
                    String(template.id) === String(editingTemplate.id)
                        ? {
                              ...template,
                              ...payload,
                              ...(updatedTemplate ?? {}),
                          }
                        : template,
                ),
            );
            setSnackbar({ message: "Template updated.", severity: "success" });
            handleEditClose();
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to update template."),
                severity: "error",
            });
        } finally {
            setEditLoading(false);
        }
    };

    const handleValidate = async (template: Template) => {
        setValidatingId(String(template.id));
        try {
            const response = await axios.get(
                `/api/templates/${template.id}/validate`,
            );
            setSnackbar({
                message: getResponseMessage(
                    response.data,
                    "Template validation completed.",
                ),
                severity: "success",
            });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to validate template."),
                severity: "error",
            });
        } finally {
            setValidatingId(null);
        }
    };

    const handleDelete = async (template: Template) => {
        const label = template.name ? `"${template.name}"` : `#${template.id}`;
        if (!window.confirm(`Delete template ${label}?`)) {
            return;
        }
        setDeletingId(String(template.id));
        try {
            await axios.delete(`/api/templates/${template.id}`);
            setTemplates((prev) =>
                prev.filter((item) => String(item.id) !== String(template.id)),
            );
            setSnackbar({ message: "Template deleted.", severity: "success" });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to delete template."),
                severity: "error",
            });
        } finally {
            setDeletingId(null);
        }
    };

    const openEditDialog = (template: Template) => {
        setEditingTemplate(template);
        const cfg = template.connection_config ?? {};
        const connType = template.connection_type ?? "guacamole";
        const detectMode = (v?: string): "creatorId" | "userId" | "custom" =>
            v === "creatorId" || v === "userId" ? v : "custom";
        setEditValues({
            name: template.name ?? "",
            type: template.type ?? "",
            proxmox_id: template.proxmox_id ? String(template.proxmox_id) : "",
            description: template.description ?? "",
            visible_to_students: Boolean(template.visible_to_students),
            connection_type: connType,
            guac_username_mode: connType === "guacamole" ? detectMode(cfg.username) : "creatorId",
            guac_username_custom: connType === "guacamole" && detectMode(cfg.username) === "custom" ? (cfg.username ?? "") : "",
            guac_password_mode: connType === "guacamole" ? detectMode(cfg.password) : "creatorId",
            guac_password_custom: connType === "guacamole" && detectMode(cfg.password) === "custom" ? (cfg.password ?? "") : "",
            ssh_port: connType === "ssh" && cfg.port ? String(cfg.port) : "",
            ssh_username_mode: connType === "ssh" ? detectMode(cfg.username) : "userId",
            ssh_username_custom: connType === "ssh" && detectMode(cfg.username) === "custom" ? (cfg.username ?? "") : "",
            ssh_password_mode: connType === "ssh" ? detectMode(cfg.password) : "userId",
            ssh_password_custom: connType === "ssh" && detectMode(cfg.password) === "custom" ? (cfg.password ?? "") : "",
            web_port: connType === "web" && cfg.port ? String(cfg.port) : "",
            web_protocol: connType === "web" ? (cfg.protocol ?? "https") : "https",
        });
        setEditOpen(true);
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
                        Templates
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Manage available VM templates and visibility.
                    </Typography>
                </Box>
                <Button
                    variant="contained"
                    startIcon={<AddOutlinedIcon fontSize="small" />}
                    onClick={() => setCreateOpen(true)}
                >
                    New template
                </Button>
            </Box>

            {error && <Alert severity="error">{error}</Alert>}

            <Paper sx={{ overflowX: "auto" }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>Name</TableCell>
                            <TableCell>Type</TableCell>
                            <TableCell>Proxmox ID</TableCell>
                            <TableCell>Visibility</TableCell>
                            <TableCell>Connection</TableCell>
                            <TableCell>Description</TableCell>
                            <TableCell align="right">Actions</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {loading ? (
                            <TableRow>
                                <TableCell colSpan={7}>
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
                        ) : templates.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={7}>
                                    <Typography
                                        variant="body2"
                                        color="text.secondary"
                                        sx={{ py: 2 }}
                                    >
                                        No templates available.
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ) : (
                            templates.map((template) => {
                                const visibilityLabel =
                                    template.visible_to_students === true
                                        ? "Visible"
                                        : template.visible_to_students === false
                                          ? "Hidden"
                                          : "Unknown";
                                return (
                                    <TableRow key={String(template.id)}>
                                        <TableCell>
                                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                                {template.name ?? `Template ${template.id}`}
                                            </Typography>
                                        </TableCell>
                                        <TableCell>{template.type ?? "-"}</TableCell>
                                        <TableCell>
                                            {template.proxmox_id ?? "-"}
                                        </TableCell>
                                        <TableCell>
                                            <Chip
                                                size="small"
                                                label={visibilityLabel}
                                                color={
                                                    template.visible_to_students === true
                                                        ? "success"
                                                        : "default"
                                                }
                                            />
                                        </TableCell>
                                        <TableCell>
                                            {template.connection_type === "ssh"
                                                ? "SSH"
                                                : template.connection_type === "web"
                                                  ? `Web (:${template.connection_config?.port ?? 443})`
                                                  : "Guacamole"}
                                        </TableCell>
                                        <TableCell>
                                            <Typography
                                                variant="body2"
                                                color="text.secondary"
                                                sx={{ maxWidth: 260 }}
                                                noWrap
                                            >
                                                {template.description ?? "-"}
                                            </Typography>
                                        </TableCell>
                                        <TableCell align="right">
                                            <Tooltip title="Open details">
                                                <IconButton
                                                    size="small"
                                                    onClick={() =>
                                                        navigate(
                                                            `/admin/templates/${template.id}`,
                                                        )
                                                    }
                                                >
                                                    <OpenInNewOutlinedIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Edit">
                                                <IconButton
                                                    size="small"
                                                    onClick={() => openEditDialog(template)}
                                                >
                                                    <EditOutlinedIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                            <Tooltip title="Validate">
                                                <span>
                                                    <IconButton
                                                        size="small"
                                                        onClick={() => handleValidate(template)}
                                                        disabled={
                                                            validatingId ===
                                                            String(template.id)
                                                        }
                                                    >
                                                        <VerifiedOutlinedIcon fontSize="small" />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                            <Tooltip title="Delete">
                                                <span>
                                                    <IconButton
                                                        size="small"
                                                        onClick={() => handleDelete(template)}
                                                        disabled={
                                                            deletingId ===
                                                            String(template.id)
                                                        }
                                                    >
                                                        <DeleteOutlinedIcon fontSize="small" />
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

            <TemplateFormDialog
                open={createOpen}
                title="Create template"
                submitLabel="Create"
                values={createValues}
                onChange={(changes) =>
                    setCreateValues((prev) => ({ ...prev, ...changes }))
                }
                onClose={handleCreateClose}
                onSubmit={handleCreate}
                loading={createLoading}
                submitDisabled={!isCreateValid || createLoading}
                typeOptions={templateTypeOptions}
            />

            <TemplateFormDialog
                open={editOpen}
                title="Edit template"
                submitLabel="Save"
                values={editValues}
                onChange={(changes) =>
                    setEditValues((prev) => ({ ...prev, ...changes }))
                }
                onClose={handleEditClose}
                onSubmit={handleEdit}
                loading={editLoading}
                submitDisabled={!isEditValid || editLoading}
                showVisibility
                typeOptions={templateTypeOptions}
            />

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
