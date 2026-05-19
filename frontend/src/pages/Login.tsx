import { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AnimatedBackground } from "@/components/AnimatedBackground";
import { useColorMode } from "@/hooks/useColorMode";
import knfLogo from "@/assets/knfLogoText.svg";

export default function Login() {
    const navigate = useNavigate();
    const { mode } = useColorMode();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            await axios.post("/api/auth/login", { username, password });
            navigate("/");
        } catch (err) {
            if (axios.isAxiosError(err) && err.response?.data?.error) {
                setError(err.response.data.error);
            } else {
                setError("Something went wrong. Please try again.");
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative min-h-screen flex items-center justify-center bg-(--color-bg)">
            <AnimatedBackground />
            <div className="absolute top-4 right-4" style={{ zIndex: 1 }}>
                <ThemeToggle />
            </div>

            <Paper
                elevation={4}
                sx={{
                    position: "relative",
                    zIndex: 1,
                    width: "100%",
                    maxWidth: 400,
                    p: 4,
                    borderRadius: 3,
                }}
            >
                <Box sx={{ display: "flex", justifyContent: "center", mb: 3 }}>
                    <img
                        src={knfLogo}
                        alt="KNF Logo"
                        style={{
                            width: 160,
                            height: "auto",
                            filter: mode === "light" ? "brightness(0)" : "none",
                        }}
                    />
                </Box>

                <Typography
                    variant="h5"
                    fontWeight={700}
                    mb={0.5}
                    color="primary"
                >
                    Virtual Lab
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={4}>
                    Sign in to your account
                </Typography>

                <Box
                    component="form"
                    onSubmit={handleSubmit}
                    className="flex flex-col gap-4"
                    sx={{ mt: 1 }}
                >
                    {error && (
                        <Alert severity="error" sx={{ borderRadius: 2 }}>
                            {error}
                        </Alert>
                    )}

                    <TextField
                        label="VU ID"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        autoFocus
                        required
                        fullWidth
                        size="small"
                    />
                    <TextField
                        label="Password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                        fullWidth
                        size="small"
                    />

                    <Button
                        type="submit"
                        variant="contained"
                        color="primary"
                        loading={loading}
                        fullWidth
                        sx={{ mt: 1 }}
                    >
                        Login
                    </Button>

                    <Divider sx={{ my: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">
                            or
                        </Typography>
                    </Divider>

                    <Button
                        variant="outlined"
                        color="primary"
                        fullWidth
                        href="/api/auth/sso"
                    >
                        Login through VU SSO
                    </Button>
                </Box>
            </Paper>
        </div>
    );
}
