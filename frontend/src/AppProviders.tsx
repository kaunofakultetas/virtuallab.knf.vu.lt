import { useMemo, type ReactNode } from "react";
import { ThemeProvider } from "@mui/material/styles";

import { ColorModeProvider, useColorMode } from "@/hooks/useColorMode";
import { getMuiTheme } from "@/styles/muiTheme";

function MuiThemeSync({ children }: { children: ReactNode }) {
    const { mode } = useColorMode();
    const theme = useMemo(() => getMuiTheme(mode), [mode]);
    return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}

export default function AppProviders({ children }: AppProvidersProps) {
    return (
        <ColorModeProvider>
            <MuiThemeSync>{children}</MuiThemeSync>
        </ColorModeProvider>
    );
}

interface AppProvidersProps {
    children: ReactNode;
}
