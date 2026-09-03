// -----------------------------------------------------------
//  [*] Pages — user settings
//
//  Three cards: the account summary (from the session
//  context), the password change form, and the dark-mode
//  switch. An SSO-only account (has_password === false)
//  gets an info notice instead of the form — there is no
//  password to change. Validation runs client-side first;
//  a 401 from the API is translated to "current password is
//  incorrect".
//
//  Used by:
//    - router.tsx — route /settings
// -----------------------------------------------------------

import { useMemo, useState } from "react";
import axios from "axios";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import { useAuth } from "@/utils/AuthGuard";
import { useColorMode } from "@/hooks/useColorMode";
import { getErrorMessage } from "@/utils/errors";

// Mirrors the backend's password schema minimum.
const MIN_PASSWORD_LENGTH = 6;


export default function Settings() {
    const auth = useAuth();
    const { mode, toggle } = useColorMode();

    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [snackbar, setSnackbar] = useState<{
        message: string;
        severity: "success" | "error";
    } | null>(null);


    // Only judged once all three fields have content, so the form is not
    // shouting at a user who has barely started typing.
    const validationError = useMemo(() => {
        if (!newPassword || !confirmPassword || !currentPassword) return null;
        if (newPassword.length < MIN_PASSWORD_LENGTH)
            return `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
        if (newPassword !== confirmPassword)
            return "New passwords do not match.";
        if (newPassword === currentPassword)
            return "New password must differ from the current one.";
        return null;
    }, [currentPassword, newPassword, confirmPassword]);

    const canSubmit =
        Boolean(currentPassword && newPassword && confirmPassword) &&
        !validationError &&
        !submitting;


    const handleChangePassword = async () => {
        setFormError(null);
        if (validationError) {
            setFormError(validationError);
            return;
        }
        setSubmitting(true);
        try {
            await axios.post("/api/auth/change-password", {
                currentPassword,
                newPassword,
            });
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setSnackbar({
                message: "Password changed successfully.",
                severity: "success",
            });
        } catch (err) {
            const message =
                axios.isAxiosError(err) && err.response?.status === 401
                    ? "Current password is incorrect."
                    : getErrorMessage(err, "Failed to change password.");
            setFormError(message);
        } finally {
            setSubmitting(false);
        }
    };


    return (
        <Stack spacing={2} sx={{ maxWidth: 640 }}>
            <Box>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                    Settings
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    Manage your account and preferences.
                </Typography>
            </Box>

            {/* Account summary */}
            <Paper sx={{ p: 3 }}>
                <Stack spacing={2}>
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>
                        Account
                    </Typography>
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
                                Username
                            </Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {auth?.vu_id ?? "-"}
                            </Typography>
                        </Box>
                        <Box>
                            <Typography variant="caption" color="text.secondary">
                                Role
                            </Typography>
                            <Box sx={{ mt: 0.5 }}>
                                <Chip
                                    size="small"
                                    label={auth?.role ?? "unknown"}
                                    color={
                                        auth?.role === "admin"
                                            ? "secondary"
                                            : "default"
                                    }
                                    sx={{ textTransform: "capitalize" }}
                                />
                            </Box>
                        </Box>
                        <Box>
                            <Typography variant="caption" color="text.secondary">
                                Last login
                            </Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {auth?.last_login
                                    ? new Date(auth.last_login).toLocaleString()
                                    : "-"}
                            </Typography>
                        </Box>
                    </Box>
                </Stack>
            </Paper>

            {/* Password change — or the SSO-only notice */}
            <Paper sx={{ p: 3 }}>
                {auth?.has_password === false ? (
                    <Stack spacing={2}>
                        <Typography variant="h6" sx={{ fontWeight: 700 }}>
                            Change password
                        </Typography>
                        <Divider />
                        <Alert severity="info">
                            Your account signs in through VU SSO, so there is no
                            password to change here.
                        </Alert>
                    </Stack>
                ) : (
                <Box
                    component="form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void handleChangePassword();
                    }}
                >
                    <Stack spacing={2}>
                        <Typography variant="h6" sx={{ fontWeight: 700 }}>
                            Change password
                        </Typography>
                        <Divider />
                        {formError && (
                            <Alert severity="error">{formError}</Alert>
                        )}
                        <TextField
                            label="Current password"
                            type="password"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            autoComplete="current-password"
                            required
                            fullWidth
                            size="small"
                        />
                        <TextField
                            label="New password"
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            autoComplete="new-password"
                            required
                            fullWidth
                            size="small"
                            helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                        />
                        <TextField
                            label="Confirm new password"
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            autoComplete="new-password"
                            required
                            fullWidth
                            size="small"
                            error={Boolean(
                                confirmPassword && newPassword !== confirmPassword,
                            )}
                        />
                        <Box>
                            <Button
                                type="submit"
                                variant="contained"
                                disabled={!canSubmit}
                                loading={submitting}
                            >
                                Update password
                            </Button>
                        </Box>
                    </Stack>
                </Box>
                )}
            </Paper>

            {/* Appearance */}
            <Paper sx={{ p: 3 }}>
                <Stack spacing={2}>
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>
                        Appearance
                    </Typography>
                    <Divider />
                    <FormControlLabel
                        control={
                            <Switch
                                checked={mode === "dark"}
                                onChange={toggle}
                            />
                        }
                        label="Dark mode"
                    />
                </Stack>
            </Paper>

            <Snackbar
                open={Boolean(snackbar)}
                autoHideDuration={4000}
                onClose={() => setSnackbar(null)}
            >
                <Alert
                    onClose={() => setSnackbar(null)}
                    severity={snackbar?.severity ?? "success"}
                    sx={{ width: "100%" }}
                >
                    {snackbar?.message}
                </Alert>
            </Snackbar>
        </Stack>
    );
}
