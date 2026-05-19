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

export function ColorModeProvider({ children }: { children: ReactNode }) {
    const [mode, setMode] = useState<Mode>(() => {
        if (typeof window === "undefined") return "light";
        const saved = localStorage.getItem("color-mode");
        if (isMode(saved)) return saved;
        return window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
    });

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

export function useColorMode() {
    const ctx = useContext(ColorModeContext);
    if (!ctx) throw new Error("useColorMode must be used within ColorModeProvider");
    return ctx;
}
