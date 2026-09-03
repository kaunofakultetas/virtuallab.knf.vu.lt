// -----------------------------------------------------------
//  [*] App — the provider stack
//
//  Color mode (our own context, persisted per browser)
//  wrapped around MUI's ThemeProvider, so the MUI theme is
//  rebuilt whenever the mode flips.
//
//  Split into (root component last):
//
//    MuiThemeSync — mode → MUI theme bridge
//    AppProviders — the exported stack (default export)
//
//  Used by:
//    - main.tsx — wraps the whole router
// -----------------------------------------------------------

import { useMemo, type ReactNode } from "react";
import { ThemeProvider } from "@mui/material/styles";

import { ColorModeProvider, useColorMode } from "@/hooks/useColorMode";
import { getMuiTheme } from "@/styles/muiTheme";


// -----------------------------------------------------------
// MuiThemeSync
// -----------------------------------------------------------
//
// Rebuilds the MUI theme when the color mode changes; must
// sit INSIDE ColorModeProvider to read the mode.
//
// Used by:
//   - AppProviders (below)
// -----------------------------------------------------------

function MuiThemeSync({ children }: { children: ReactNode }) {
    const { mode } = useColorMode();
    const theme = useMemo(() => getMuiTheme(mode), [mode]);
    return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}








// -----------------------------------------------------------
// AppProviders (default export)
// -----------------------------------------------------------
//
// Used by:
//   - main.tsx
// -----------------------------------------------------------

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
