// -----------------------------------------------------------
//  [*] Hooks — color mode (light/dark)
//
//  The app-wide light/dark switch: initial value from
//  localStorage, falling back to the OS preference; every
//  change is persisted and mirrored onto the <html> "dark"
//  class so Tailwind's dark: variants follow MUI.
//
//    const { mode, toggle } = useColorMode()
//
//  Used by:
//    - AppProviders.tsx — the provider wraps the app
//    - ThemeToggle.tsx, AnimatedBackground.tsx — consumers
// -----------------------------------------------------------

import {
    createElement,
    createContext,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from "react";

type Mode = "light" | "dark";

const isMode = (value: string | null): value is Mode =>
    value === "light" || value === "dark";

interface ColorModeContextValue {
    mode: Mode;
    toggle: () => void;
}

const ColorModeContext = createContext<ColorModeContextValue | null>(null);








// -----------------------------------------------------------
// ColorModeProvider
// -----------------------------------------------------------
//
// createElement rather than JSX because this file is .ts —
// renaming it .tsx would churn every import for one call.
//
// Used by:
//   - AppProviders.tsx
// -----------------------------------------------------------

export function ColorModeProvider({ children }: { children: ReactNode }) {
    const [mode, setMode] = useState<Mode>(() => {
        if (typeof window === "undefined") return "light";
        const saved = localStorage.getItem("color-mode");
        if (isMode(saved)) return saved;
        return window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
    });

    // Keep Tailwind (html.dark) and the saved preference in step with MUI.
    useEffect(() => {
        document.documentElement.classList.toggle("dark", mode === "dark");
        localStorage.setItem("color-mode", mode);
    }, [mode]);

    return createElement(
        ColorModeContext.Provider,
        { value: { mode, toggle: () => setMode((m) => (m === "light" ? "dark" : "light")) } },
        children,
    );
}








// -----------------------------------------------------------
// useColorMode
// -----------------------------------------------------------
//
// Used by:
//   - AppProviders.tsx, ThemeToggle.tsx,
//     AnimatedBackground.tsx
// -----------------------------------------------------------

export function useColorMode() {
    const ctx = useContext(ColorModeContext);
    if (!ctx) throw new Error("useColorMode must be used within ColorModeProvider");
    return ctx;
}
