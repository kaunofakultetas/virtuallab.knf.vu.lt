import React from "react";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import MenuItem from "@mui/material/MenuItem";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import type { ConnectionType } from "@/types/templates";

export type SshCredentialMode = "creatorId" | "userId" | "custom";

export interface TemplateFormValues {
    name: string;
    type: string;
    proxmox_id: string;
    description: string;
    visible_to_students: boolean;
    connection_type: ConnectionType;
    // SSH config
    ssh_port: string;
    ssh_username_mode: SshCredentialMode;
    ssh_username_custom: string;
    ssh_password_mode: SshCredentialMode;
    ssh_password_custom: string;
    // Web interface config
    web_port: string;
    web_protocol: string;
}

interface TemplateFormDialogProps {
    open: boolean;
    title: string;
    submitLabel: string;
    values: TemplateFormValues;
    onChange: (changes: Partial<TemplateFormValues>) => void;
    onClose: () => void;
    onSubmit: () => void;
    loading?: boolean;
    submitDisabled?: boolean;
    showVisibility?: boolean;
    typeOptions?: string[];
}

const connectionTypeOptions = [
    { value: "guacamole", label: "Guacamole (RDP)" },
    { value: "ssh", label: "SSH (browser terminal)" },
    { value: "web", label: "Web interface (HTTP/HTTPS)" },
];

export function TemplateFormDialog({
    open,
    title,
    submitLabel,
    values,
    onChange,
    onClose,
    onSubmit,
    loading = false,
    submitDisabled = false,
    showVisibility = false,
    typeOptions,
}: TemplateFormDialogProps) {
    const hasTypeOptions = Boolean(typeOptions?.length);

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
            <Box
                component="form"
                onSubmit={(e: React.FormEvent) => { e.preventDefault(); onSubmit(); }}
                sx={{ bgcolor: "background.paper", backgroundImage: "none", borderRadius: 2 }}
            >
            <DialogTitle>{title}</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ mt: 1 }}>
                    <TextField
                        label="Name"
                        value={values.name}
                        onChange={(event) =>
                            onChange({ name: event.target.value })
                        }
                        required
                        fullWidth
                        size="small"
                    />
                    <TextField
                        label="Type"
                        value={values.type}
                        onChange={(event) =>
                            onChange({ type: event.target.value })
                        }
                        required
                        fullWidth
                        size="small"
                        select={hasTypeOptions}
                        slotProps={
                            hasTypeOptions
                                ? { select: { displayEmpty: true } }
                                : undefined
                        }
                    >
                        {hasTypeOptions && (
                            <MenuItem value="" disabled>
                                Select type
                            </MenuItem>
                        )}
                        {typeOptions?.map((option) => (
                            <MenuItem key={option} value={option}>
                                {option}
                            </MenuItem>
                        ))}
                    </TextField>
                    <TextField
                        label="Proxmox ID"
                        value={values.proxmox_id}
                        onChange={(event) =>
                            onChange({ proxmox_id: event.target.value })
                        }
                        required
                        fullWidth
                        size="small"
                    />
                    <TextField
                        label="Description"
                        value={values.description}
                        onChange={(event) =>
                            onChange({ description: event.target.value })
                        }
                        fullWidth
                        size="small"
                        multiline
                        minRows={2}
                    />

                    <Divider />
                    <Typography variant="subtitle2" color="text.secondary">
                        Connection
                    </Typography>

                    <TextField
                        label="Connection type"
                        value={values.connection_type}
                        onChange={(event) =>
                            onChange({ connection_type: event.target.value as ConnectionType })
                        }
                        select
                        fullWidth
                        size="small"
                    >
                        {connectionTypeOptions.map((opt) => (
                            <MenuItem key={opt.value} value={opt.value}>
                                {opt.label}
                            </MenuItem>
                        ))}
                    </TextField>

                    {values.connection_type === "ssh" && (
                        <>
                            <TextField
                                label="SSH port"
                                value={values.ssh_port}
                                onChange={(e) => onChange({ ssh_port: e.target.value })}
                                placeholder="22"
                                fullWidth
                                size="small"
                                type="number"
                                slotProps={{ htmlInput: { min: 1, max: 65535 } }}
                            />
                            <TextField
                                label="SSH username"
                                value={values.ssh_username_mode}
                                onChange={(e) =>
                                    onChange({ ssh_username_mode: e.target.value as SshCredentialMode })
                                }
                                select
                                fullWidth
                                size="small"
                            >
                                <MenuItem value="creatorId">Machine creator ID</MenuItem>
                                <MenuItem value="userId">Connecting user ID</MenuItem>
                                <MenuItem value="custom">Custom</MenuItem>
                            </TextField>
                            {values.ssh_username_mode === "custom" && (
                                <TextField
                                    label="Custom username"
                                    value={values.ssh_username_custom}
                                    onChange={(e) => onChange({ ssh_username_custom: e.target.value })}
                                    fullWidth
                                    size="small"
                                />
                            )}
                            <TextField
                                label="SSH password"
                                value={values.ssh_password_mode}
                                onChange={(e) =>
                                    onChange({ ssh_password_mode: e.target.value as SshCredentialMode })
                                }
                                select
                                fullWidth
                                size="small"
                            >
                                <MenuItem value="creatorId">Machine creator ID</MenuItem>
                                <MenuItem value="userId">Connecting user ID</MenuItem>
                                <MenuItem value="custom">Custom</MenuItem>
                            </TextField>
                            {values.ssh_password_mode === "custom" && (
                                <TextField
                                    label="Custom password"
                                    value={values.ssh_password_custom}
                                    onChange={(e) => onChange({ ssh_password_custom: e.target.value })}
                                    fullWidth
                                    size="small"
                                    type="password"
                                />
                            )}
                        </>
                    )}

                    {values.connection_type === "web" && (
                        <>
                            <TextField
                                label="Web UI port"
                                value={values.web_port}
                                onChange={(e) => onChange({ web_port: e.target.value })}
                                placeholder="443"
                                fullWidth
                                size="small"
                                type="number"
                                slotProps={{ htmlInput: { min: 1, max: 65535 } }}
                            />
                            <TextField
                                label="Web UI protocol"
                                value={values.web_protocol}
                                onChange={(e) => onChange({ web_protocol: e.target.value })}
                                select
                                fullWidth
                                size="small"
                            >
                                <MenuItem value="https">HTTPS</MenuItem>
                                <MenuItem value="http">HTTP</MenuItem>
                            </TextField>
                        </>
                    )}

                    {showVisibility && (
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={values.visible_to_students}
                                    onChange={(event) =>
                                        onChange({
                                            visible_to_students:
                                                event.target.checked,
                                        })
                                    }
                                />
                            }
                            label="Visible to students"
                        />
                    )}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={loading}>
                    Cancel
                </Button>
                <Button
                    type="submit"
                    variant="contained"
                    disabled={submitDisabled}
                    loading={loading}
                >
                    {submitLabel}
                </Button>
            </DialogActions>
            </Box>
        </Dialog>
    );
}
