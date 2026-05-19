import { useRouteError, isRouteErrorResponse, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import ArrowBackOutlinedIcon from "@mui/icons-material/ArrowBackOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import { AnimatedBackground } from "@/components/AnimatedBackground";

export default function ErrorPage() {
    const error    = useRouteError();
    const navigate = useNavigate();

    let status  = 500;
    let title   = "Something went wrong";
    let message = "An unexpected error occurred. Please try again.";

    if (isRouteErrorResponse(error)) {
        status = error.status;
        if (status === 404) {
            title   = "Page not found";
            message = "The page you're looking for doesn't exist or has been moved.";
        } else if (status === 401) {
            title   = "Unauthorized";
            message = "You don't have permission to view this page.";
        } else if (status === 403) {
            title   = "Forbidden";
            message = "Access to this resource is denied.";
        } else {
            message = error.statusText || message;
        }
    } else if (error instanceof Error) {
        message = error.message;
    }

    return (
        <Box
            sx={{
                minHeight: "100vh",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                px: 3,
                gap: 0,
                position: "relative",
            }}
        >
            <AnimatedBackground />
            {/* Big status number */}
            <Typography
                sx={{ position: "relative", zIndex: 1 }}
                sx={{
                    fontSize: { xs: "6rem", sm: "9rem" },
                    fontWeight: 800,
                    lineHeight: 1,
                    color: "primary.main",
                    opacity: 0.12,
                    userSelect: "none",
                    letterSpacing: "-0.05em",
                }}
            >
                {status}
            </Typography>

            {/* Content — overlaps the number via negative margin */}
            <Box
                sx={{
                    position: "relative",
                    zIndex: 1,
                    mt: "-2.5rem",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 1.5,
                    textAlign: "center",
                    maxWidth: 420,
                }}
            >
                <Typography variant="h5" fontWeight={700} color="text.primary">
                    {title}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    {message}
                </Typography>

                <Box sx={{ display: "flex", gap: 1.5, mt: 1 }}>
                    <Button
                        variant="outlined"
                        color="primary"
                        size="small"
                        startIcon={<ArrowBackOutlinedIcon fontSize="small" />}
                        onClick={() => navigate(-1)}
                        sx={{ textTransform: "none" }}
                    >
                        Go back
                    </Button>
                    <Button
                        variant="contained"
                        color="primary"
                        size="small"
                        startIcon={<HomeOutlinedIcon fontSize="small" />}
                        onClick={() => navigate("/")}
                        sx={{ textTransform: "none" }}
                    >
                        Dashboard
                    </Button>
                </Box>
            </Box>
        </Box>
    );
}
