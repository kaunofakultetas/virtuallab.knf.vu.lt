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

export interface TemplateFormValues {
    name: string;
    type: string;
    proxmox_id: string;
    description: string;
    visible_to_students: boolean;
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
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth="sm"
            PaperComponent="form"
            slotProps={{
                paper: {
                    onSubmit: (event) => {
                        event.preventDefault();
                        onSubmit();
                    },
                    sx: {
                        bgcolor: "background.paper",
                        backgroundImage: "none",
                        borderRadius: 2,
                    },
                },
            }}
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
        </Dialog>
    );
}
