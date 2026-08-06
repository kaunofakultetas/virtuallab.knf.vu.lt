import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        allowedHosts: ["localhost", "virtuallab.knf.vu.lt"],
        proxy: {
            "/api": {
                target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000",
                changeOrigin: true,
                rewrite: (requestPath) => requestPath.replace(/^\/api/, ""),
            },
        },
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
