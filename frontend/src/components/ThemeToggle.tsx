import { ButtonBase, Box, Tooltip } from "@mui/material";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import { useColorMode } from "@/hooks/useColorMode";

export function ThemeToggle({ onDark = false }: { onDark?: boolean }) {
    const { mode, toggle } = useColorMode();
    const isDark = mode === "dark";

    return (
        <Tooltip
            title={`Switch to ${isDark ? "light" : "dark"} mode`}
            arrow
            enterDelay={300}
        >
            <ButtonBase
                onClick={toggle}
                aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
                focusRipple
                sx={{
                    width: 44,
                    height: 44,
                    borderRadius: 1,
                    perspective: "600px",
                    transition: "transform 150ms ease",
                    "&:active": { transform: "scale(0.92)" },
                    "&:hover .face-front": { borderColor: onDark ? "rgba(255,255,255,0.7)" : "primary.main" },
                    "&:hover .face-front svg": { transform: "rotate(45deg)" },
                    "&:hover .face-back": { borderColor: onDark ? "rgba(255,255,255,0.7)" : "secondary.main" },
                    "&:hover .face-back svg": { transform: "rotate(-12deg)" },
                }}
            >
                <Box
                    sx={{
                        position: "relative",
                        width: "100%",
                        height: "100%",
                        transformStyle: "preserve-3d",
                        transition:
                            "transform 300ms cubic-bezier(0.68, -0.4, 0.27, 1.45)",
                        transform: isDark ? "rotateY(180deg)" : "rotateY(0deg)",
                    }}
                >
                    <Face className="face-front" onDark={onDark}>
                        <LightModeOutlinedIcon
                            sx={{
                                fontSize: 22,
                                color: onDark ? "#fff" : "#78003F",
                                transition: "transform 400ms ease",
                            }}
                        />
                    </Face>
                    <Face className="face-back" back onDark={onDark}>
                        <DarkModeOutlinedIcon
                            sx={{
                                fontSize: 22,
                                color: onDark ? "#fff" : "#E64164",
                                transition: "transform 400ms ease",
                            }}
                        />
                    </Face>
                </Box>
            </ButtonBase>
        </Tooltip>
    );
}

function Face({
    children,
    back = false,
    onDark = false,
    className,
}: {
    children: React.ReactNode;
    back?: boolean;
    onDark?: boolean;
    className?: string;
}) {
    const bgcolor     = onDark ? "rgba(255,255,255,0.12)" : (back ? "#1E1E1E" : "#FAFAFA");
    const borderColor = onDark ? "rgba(255,255,255,0.22)" : (back ? "#3A3A3A" : "#DCDCDC");

    return (
        <Box
            className={className}
            sx={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 1,
                bgcolor,
                border: "1px solid",
                borderColor,
                backfaceVisibility: "hidden",
                transform: back ? "rotateY(180deg)" : undefined,
                transition: "border-color 200ms ease",
            }}
        >
            {children}
        </Box>
    );
}
