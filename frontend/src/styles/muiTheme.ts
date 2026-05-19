import { createTheme } from "@mui/material/styles";

const palettes = {
    light: {
        primary: "#78003F",
        primaryContrast: "#FFFFFF",
        accent: "#E64164",
        accentContrast: "#FFFFFF",
        bg: "#FFFFFF",
        surface: "#FAFAFA",
        text: "#414141",
        textMuted: "#6B6B6B",
        border: "#DCDCDC",
    },
    dark: {
        primary: "#D6336C",
        primaryContrast: "#FFFFFF",
        accent: "#E64164",
        accentContrast: "#FFFFFF",
        bg: "#121212",
        surface: "#1E1E1E",
        text: "#F5F5F5",
        textMuted: "#A0A0A0",
        border: "#3A3A3A",
    },
} as const;

export const getMuiTheme = (mode: "light" | "dark") => {
    const p = palettes[mode];
    return createTheme({
        palette: {
            mode,
            primary: { main: p.primary, contrastText: p.primaryContrast },
            secondary: { main: p.accent, contrastText: p.accentContrast },
            background: { default: p.bg, paper: p.surface },
            text: { primary: p.text, secondary: p.textMuted },
            divider: p.border,
        },
        shape: { borderRadius: 8 },
        typography: { fontFamily: "Roboto, system-ui, sans-serif" },
    });
};
