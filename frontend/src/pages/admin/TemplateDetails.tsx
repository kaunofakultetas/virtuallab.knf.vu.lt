import { useMemo, useState } from "react";
import { useLoaderData, useNavigate } from "react-router-dom";
import axios from "axios";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import ArrowBackOutlinedIcon from "@mui/icons-material/ArrowBackOutlined";
import type { Template } from "@/types/templates";
import { TemplateFormDialog } from "@/components/templates/TemplateFormDialog";
import type { TemplateFormValues } from "@/components/templates/TemplateFormDialog";
import {
    extractTemplate,
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
};

export default function TemplateDetails() {
    const navigate = useNavigate();
    const loaderTemplate = useLoaderData<Template>();
    const [overrides, setOverrides] = useState<Record<string, Template>>({});
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error" | "info";
    } | null>(null);

    const [editOpen, setEditOpen] = useState(false);
    const [editValues, setEditValues] =
        useState<TemplateFormValues>(emptyFormValues);
    const [editLoading, setEditLoading] = useState(false);
    const [validating, setValidating] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const isEditValid = useMemo(
        () =>
            Boolean(
                editValues.name.trim() &&
                    editValues.type.trim() &&
                    editValues.proxmox_id.trim(),
            ),
        [editValues],
    );

    const template = overrides[String(loaderTemplate.id)] ?? loaderTemplate;

    const openEditDialog = () => {
        setEditValues({
            name: template.name ?? "",
            type: template.type ?? "",
            proxmox_id: template.proxmox_id ? String(template.proxmox_id) : "",
            description: template.description ?? "",
            visible_to_students: Boolean(template.visible_to_students),
        });
        setEditOpen(true);
    };

    const handleEdit = async () => {
        if (!isEditValid) {
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
            };
            const response = await axios.patch(`/api/templates/${template.id}`, payload);
            const updatedTemplate = extractTemplate(response.data);
            const merged = { ...template, ...payload, ...(updatedTemplate ?? {}) };
            setOverrides((prev) => ({
                ...prev,
                [String(template.id)]: merged,
            }));
            setSnackbar({ message: "Template updated.", severity: "success" });
            setEditOpen(false);
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to update template."),
                severity: "error",
            });
        } finally {
            setEditLoading(false);
        }
    };

    const handleValidate = async () => {
        setValidating(true);
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
            setValidating(false);
        }
    };

    const handleDelete = async () => {
        const label = template.name ? `"${template.name}"` : `#${template.id}`;
        if (!window.confirm(`Delete template ${label}?`)) {
            return;
        }
        setDeleting(true);
        try {
            await axios.delete(`/api/templates/${template.id}`);
            navigate("/admin/templates");
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to delete template."),
                severity: "error",
            });
        } finally {
            setDeleting(false);
        }
    };

    const visibilityLabel =
        template?.visible_to_students === true
            ? "Visible"
            : template?.visible_to_students === false
              ? "Hidden"
              : "Unknown";

    return (
        <Stack spacing={2}>
            <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
                <Box>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                        Template details
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Review and update template configuration.
                    </Typography>
                </Box>
                <Button
                    variant="outlined"
                    startIcon={<ArrowBackOutlinedIcon fontSize="small" />}
                    onClick={() => navigate("/admin/templates")}
                >
                    Back to templates
                </Button>
            </Box>

            {template ? (
                <Paper sx={{ p: 3 }}>
                    <Stack spacing={2}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                            <Typography variant="h6" sx={{ fontWeight: 700 }}>
                                {template.name ?? `Template ${template.id}`}
                            </Typography>
                            <Chip
                                size="small"
                                label={visibilityLabel}
                                color={
                                    template.visible_to_students === true
                                        ? "success"
                                        : "default"
                                }
                            />
                        </Box>

                        <Divider />

                        <Box
                            sx={{
                                display: "grid",
                                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                                gap: 2,
                            }}
                        >
                            <Box>
                                <Typography variant="caption" color="text.secondary">
                                    Template ID
                                </Typography>
                                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                    {template.id}
                                </Typography>
                            </Box>
                            <Box>
                                <Typography variant="caption" color="text.secondary">
                                    Type
                                </Typography>
                                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                    {template.type ?? "-"}
                                </Typography>
                            </Box>
                            <Box>
                                <Typography variant="caption" color="text.secondary">
                                    Proxmox ID
                                </Typography>
                                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                    {template.proxmox_id ?? "-"}
                                </Typography>
                            </Box>
                            <Box>
                                <Typography variant="caption" color="text.secondary">
                                    Description
                                </Typography>
                                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                    {template.description || "No description"}
                                </Typography>
                            </Box>
                        </Box>

                        <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap" }}>
                            <Button
                                variant="contained"
                                startIcon={<EditOutlinedIcon fontSize="small" />}
                                onClick={openEditDialog}
                            >
                                Edit
                            </Button>
                            <Button
                                variant="outlined"
                                startIcon={<VerifiedOutlinedIcon fontSize="small" />}
                                onClick={handleValidate}
                                disabled={validating}
                            >
                                Validate
                            </Button>
                            <Button
                                variant="outlined"
                                color="error"
                                startIcon={<DeleteOutlinedIcon fontSize="small" />}
                                onClick={handleDelete}
                                disabled={deleting}
                            >
                                Delete
                            </Button>
                        </Box>
                    </Stack>
                </Paper>
            ) : (
                <Alert severity="error">Template data is unavailable.</Alert>
            )}

            <TemplateFormDialog
                open={editOpen}
                title="Edit template"
                submitLabel="Save"
                values={editValues}
                onChange={(changes) =>
                    setEditValues((prev) => ({ ...prev, ...changes }))
                }
                onClose={() => setEditOpen(false)}
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
