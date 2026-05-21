import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Avatar from "@mui/material/Avatar";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/utils/AuthGuard";
import { useNavigate } from "react-router-dom";
import vuLogo from "@/assets/vuLogo.svg";

interface NavbarProps {
    onLogout: () => void;
}

export function Navbar({ onLogout }: NavbarProps) {
    const auth = useAuth();
    const navigate = useNavigate();

    return (
        <Box
            component="header"
            sx={{
                height: 64,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                px: 2,
                bgcolor: "#78003F",
                zIndex: 10,
            }}
        >
            <Box
                onClick={() => navigate("/")}
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1.5,
                    cursor: "pointer",
                    borderRadius: 1,
                    px: 0.5,
                    "&:hover": { bgcolor: "rgba(255,255,255,0.1)" },
                }}
            >
                <img
                    src={vuLogo}
                    alt="VU"
                    style={{ height: 48, filter: "brightness(0) invert(1)" }}
                />
                <Divider
                    orientation="vertical"
                    flexItem
                    sx={{ borderColor: "rgba(255,255,255,0.3)", my: 1 }}
                />
                <Typography
                    variant="subtitle1"
                    fontWeight={600}
                    sx={{ color: "#fff", whiteSpace: "nowrap" }}
                >
                    Virtual Lab
                </Typography>
            </Box>

            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                {auth && (
                    <Box
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                            height: 44,
                            border: "1px solid rgba(255,255,255,0.25)",
                            borderRadius: 2,
                            px: 1.5,
                        }}
                    >
                        <Avatar
                            sx={{
                                width: 28,
                                height: 28,
                                bgcolor: "rgba(255,255,255,0.2)",
                                fontSize: 12,
                            }}
                        >
                            {auth.vu_id.slice(0, 2).toUpperCase()}
                        </Avatar>
                        <Box
                            sx={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                textAlign: "center",
                            }}
                        >
                            <Typography
                                variant="body2"
                                fontWeight={600}
                                sx={{ color: "#fff", lineHeight: 1.1 }}
                            >
                                {auth.vu_id}
                            </Typography>
                            <Typography
                                variant="caption"
                                sx={{
                                    color: "rgba(255,255,255,0.65)",
                                    fontSize: "0.7rem",
                                    lineHeight: 1,
                                    textTransform: "capitalize",
                                }}
                            >
                                {auth.role}
                            </Typography>
                        </Box>
                    </Box>
                )}
                <ThemeToggle onDark />
                <Button
                    variant="outlined"
                    startIcon={<LogoutOutlinedIcon fontSize="small" />}
                    onClick={onLogout}
                    sx={{
                        height: 44,
                        color: "#fff",
                        borderColor: "rgba(255,255,255,0.45)",
                        "&:hover": {
                            borderColor: "#fff",
                            bgcolor: "rgba(255,255,255,0.1)",
                        },
                        textTransform: "none",
                        whiteSpace: "nowrap",
                    }}
                >
                    Logout
                </Button>
            </Box>
        </Box>
    );
}
