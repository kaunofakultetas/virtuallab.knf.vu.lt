// -----------------------------------------------------------
//  [*] Admin — lab profiles
//
//  The lab-profile CRUD page: a table of profiles (template
//  and domain counts, the protected Default chip) and one
//  dialog for both create and edit — `editing` null means
//  create. Domains are edited as a growable row list; the
//  backend re-validates them as strict hostnames, so this
//  form only trims and lowercases.
//
//  Used by:
//    - router.tsx — route /admin/lab-profiles
// -----------------------------------------------------------

import { useEffect, useState } from "react";
import axios from "axios";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import type { LabProfile, AllowedWebDomain } from "@/types/labProfiles";
import type { Template } from "@/types/templates";
import { getErrorMessage } from "@/utils/errors";

interface ProfileFormValues {
    name: string;
    description: string;
    allow_same_group: boolean;
    domains: AllowedWebDomain[];
    template_ids: number[];
}

const emptyValues: ProfileFormValues = {
    name: "",
    description: "",
    allow_same_group: true,
    domains: [],
    template_ids: [],
};

export default function LabProfiles() {
    const [profiles, setProfiles] = useState<LabProfile[]>([]);
    const [templates, setTemplates] = useState<Template[]>([]);
    const [fetching, setFetching] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<LabProfile | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [values, setValues] = useState<ProfileFormValues>(emptyValues);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error";
    } | null>(null);

    const fetchData = async () => {
        setFetching(true);
        setError(null);
        try {
            const [profilesResponse, templatesResponse] = await Promise.all([
                axios.get<LabProfile[]>("/api/lab-profiles"),
                axios.get<Template[]>("/api/templates"),
            ]);
            setProfiles(Array.isArray(profilesResponse.data) ? profilesResponse.data : []);
            setTemplates(Array.isArray(templatesResponse.data) ? templatesResponse.data : []);
        } catch (err) {
            setError(getErrorMessage(err, "Failed to load lab profiles."));
        } finally {
            setFetching(false);
        }
    };

    useEffect(() => {
        void fetchData();
    }, []);


    // The one dialog serves both flows: `editing` decides POST vs PATCH.
    const openCreate = () => {
        setEditing(null);
        setValues(emptyValues);
        setDialogOpen(true);
    };

    const openEdit = (profile: LabProfile) => {
        setEditing(profile);
        setValues({
            name: profile.name,
            description: profile.description ?? "",
            allow_same_group: profile.allow_same_group,
            domains: profile.domains.map((domain) => ({ ...domain })),
            template_ids: profile.templates.map((template) => Number(template.id)),
        });
        setDialogOpen(true);
    };

    const updateDomain = (
        index: number,
        changes: Partial<AllowedWebDomain>,
    ) => {
        setValues((current) => ({
            ...current,
            domains: current.domains.map((domain, domainIndex) =>
                domainIndex === index ? { ...domain, ...changes } : domain,
            ),
        }));
    };

    const saveProfile = async () => {
        setSaving(true);
        try {
            const payload = {
                ...values,
                name: values.name.trim(),
                description: values.description.trim(),
                domains: values.domains.map((domain) => ({
                    ...domain,
                    domain: domain.domain.trim().toLowerCase(),
                })),
            };
            if (editing) {
                await axios.patch(`/api/lab-profiles/${editing.id}`, payload);
            } else {
                await axios.post("/api/lab-profiles", payload);
            }
            setDialogOpen(false);
            setSnackbar({
                message: editing ? "Lab profile updated." : "Lab profile created.",
                severity: "success",
            });
            await fetchData();
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to save lab profile."),
                severity: "error",
            });
        } finally {
            setSaving(false);
        }
    };

    const deleteProfile = async (profile: LabProfile) => {
        setDeletingId(profile.id);
        try {
            await axios.delete(`/api/lab-profiles/${profile.id}`);
            setProfiles((current) => current.filter(({ id }) => id !== profile.id));
            setSnackbar({ message: "Lab profile deleted.", severity: "success" });
        } catch (err) {
            setSnackbar({
                message: getErrorMessage(err, "Failed to delete lab profile."),
                severity: "error",
            });
        } finally {
            setDeletingId(null);
        }
    };

    return (
        <Stack spacing={2.5}>
            <Stack
                direction="row"
                sx={{ alignItems: "center", justifyContent: "space-between" }}
            >
                <Box>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>Lab profiles</Typography>
                    <Typography variant="body2" color="text.secondary">
                        Domain policy and VM templates available to each lab.
                    </Typography>
                </Box>
                <Button variant="contained" startIcon={<AddOutlinedIcon />} onClick={openCreate}>
                    Add profile
                </Button>
            </Stack>

            {error && <Alert severity="error">{error}</Alert>}
            <Paper variant="outlined" sx={{ overflow: "hidden" }}>
                {fetching ? (
                    <Box sx={{ display: "grid", placeItems: "center", minHeight: 220 }}>
                        <CircularProgress size={28} />
                    </Box>
                ) : (
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>Profile</TableCell>
                                <TableCell>Templates</TableCell>
                                <TableCell>Web domains</TableCell>
                                <TableCell align="right">Actions</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {profiles.map((profile) => (
                                <TableRow key={profile.id} hover>
                                    <TableCell>
                                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{profile.name}</Typography>
                                            {profile.is_default && <Chip label="Default" size="small" />}
                                        </Stack>
                                        {profile.description && (
                                            <Typography variant="caption" color="text.secondary">
                                                {profile.description}
                                            </Typography>
                                        )}
                                    </TableCell>
                                    <TableCell>{profile.templates.length}</TableCell>
                                    <TableCell>{profile.domains.length}</TableCell>
                                    <TableCell align="right">
                                        <Tooltip title="Edit profile">
                                            <IconButton size="small" onClick={() => openEdit(profile)}>
                                                <EditOutlinedIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title={profile.is_default ? "The default profile cannot be deleted" : "Delete profile"}>
                                            <span>
                                                <IconButton
                                                    size="small"
                                                    color="error"
                                                    disabled={profile.is_default || deletingId === profile.id}
                                                    onClick={() => void deleteProfile(profile)}
                                                >
                                                    <DeleteOutlinedIcon fontSize="small" />
                                                </IconButton>
                                            </span>
                                        </Tooltip>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </Paper>

            <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="md">
                <DialogTitle>{editing ? "Edit lab profile" : "Create lab profile"}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2.5} sx={{ mt: 1 }}>
                        <TextField
                            label="Name"
                            value={values.name}
                            onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
                            required
                            size="small"
                        />
                        <TextField
                            label="Description"
                            value={values.description}
                            onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))}
                            multiline
                            minRows={2}
                            size="small"
                        />
                        <FormControl size="small">
                            <InputLabel id="profile-templates-label">VM templates</InputLabel>
                            <Select
                                labelId="profile-templates-label"
                                multiple
                                value={values.template_ids}
                                label="VM templates"
                                onChange={(event) => setValues((current) => ({
                                    ...current,
                                    template_ids: event.target.value as number[],
                                }))}
                                renderValue={(selected) => `${selected.length} selected`}
                            >
                                {templates.map((template) => (
                                    <MenuItem key={template.id} value={Number(template.id)}>
                                        <Checkbox checked={values.template_ids.includes(Number(template.id))} />
                                        <ListItemText primary={template.name ?? `Template ${template.id}`} />
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={values.allow_same_group}
                                    onChange={(event) => setValues((current) => ({
                                        ...current,
                                        allow_same_group: event.target.checked,
                                    }))}
                                />
                            }
                            label="Allow communication between this user's VMs in the lab"
                        />

                        <Stack
                            direction="row"
                            sx={{ alignItems: "center", justifyContent: "space-between" }}
                        >
                            <Typography variant="subtitle2">Approved web domains</Typography>
                            <Button
                                size="small"
                                startIcon={<AddOutlinedIcon />}
                                onClick={() => setValues((current) => ({
                                    ...current,
                                    domains: [...current.domains, { domain: "", include_subdomains: true }],
                                }))}
                            >
                                Add domain
                            </Button>
                        </Stack>
                        {values.domains.length === 0 && (
                            <Alert severity="info">No public web domains are approved for this profile.</Alert>
                        )}
                        {values.domains.map((domain, index) => (
                            <Stack
                                key={index}
                                direction={{ xs: "column", sm: "row" }}
                                spacing={1}
                                sx={{ alignItems: { sm: "center" } }}
                            >
                                <TextField
                                    label="Domain"
                                    placeholder="example.org"
                                    value={domain.domain}
                                    onChange={(event) => updateDomain(index, { domain: event.target.value })}
                                    required
                                    fullWidth
                                    size="small"
                                />
                                <FormControlLabel
                                    sx={{ minWidth: 190 }}
                                    control={
                                        <Checkbox
                                            checked={domain.include_subdomains}
                                            onChange={(event) => updateDomain(index, { include_subdomains: event.target.checked })}
                                        />
                                    }
                                    label="Include subdomains"
                                />
                                <Tooltip title="Remove domain">
                                    <IconButton
                                        size="small"
                                        onClick={() => setValues((current) => ({
                                            ...current,
                                            domains: current.domains.filter((_, domainIndex) => domainIndex !== index),
                                        }))}
                                    >
                                        <DeleteOutlinedIcon fontSize="small" />
                                    </IconButton>
                                </Tooltip>
                            </Stack>
                        ))}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button
                        variant="contained"
                        onClick={() => void saveProfile()}
                        disabled={saving || !values.name.trim() || values.domains.some(({ domain }) => !domain.trim())}
                    >
                        {saving ? "Saving..." : "Save"}
                    </Button>
                </DialogActions>
            </Dialog>

            <Snackbar
                open={Boolean(snackbar)}
                autoHideDuration={5000}
                onClose={() => setSnackbar(null)}
            >
                {snackbar ? (
                    <Alert severity={snackbar.severity} onClose={() => setSnackbar(null)}>
                        {snackbar.message}
                    </Alert>
                ) : undefined}
            </Snackbar>
        </Stack>
    );
}