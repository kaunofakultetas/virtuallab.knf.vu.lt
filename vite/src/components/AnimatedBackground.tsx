import { useEffect, useRef } from "react";
import { useColorMode } from "@/hooks/useColorMode";

export function AnimatedBackground() {
    const { mode } = useColorMode();
    const layerRef = useRef<HTMLDivElement>(null);
    const target = useRef({ x: 0, y: 0 });
    const current = useRef({ x: 0, y: 0 });
    const raf = useRef<number>(0);

    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            target.current = {
                x: ((e.clientX - cx) / cx) * 28,
                y: ((e.clientY - cy) / cy) * 28,
            };
        };

        const tick = () => {
            current.current.x += (target.current.x - current.current.x) * 0.06;
            current.current.y += (target.current.y - current.current.y) * 0.06;
            if (layerRef.current) {
                layerRef.current.style.transform = `translate(${current.current.x}px, ${current.current.y}px)`;
            }
            raf.current = requestAnimationFrame(tick);
        };

        window.addEventListener("mousemove", onMouseMove);
        raf.current = requestAnimationFrame(tick);

        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            cancelAnimationFrame(raf.current);
        };
    }, []);

    const dotColor  = mode === "light" ? "rgba(120,0,63,0.35)" : "rgba(214,51,108,0.45)";
    const bgColor   = mode === "light" ? "#ffffff" : "#121212";
    const fadeColor = mode === "light" ? "rgba(255,255,255,0.75)" : "rgba(18,18,18,0.75)";

    return (
        <div style={{ position: "fixed", inset: 0, overflow: "hidden", zIndex: 0, backgroundColor: bgColor, pointerEvents: "none" }}>
            <div
                ref={layerRef}
                style={{
                    position: "absolute",
                    inset: "-60px",
                    backgroundImage: `radial-gradient(circle, ${dotColor} 1.5px, transparent 1.5px)`,
                    backgroundSize: "28px 28px",
                }}
            />
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    background: `radial-gradient(ellipse 55% 60% at 50% 50%, ${fadeColor} 0%, transparent 100%)`,
                }}
            />
        </div>
    );
}
