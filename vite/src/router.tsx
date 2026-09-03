// -----------------------------------------------------------
//  [*] App — the route table
//
//  Every page, lazy-loaded, with auth layered in the router:
//  /login and /privacy are public, everything under "/"
//  requires a session (AuthProvider + RequireAuth around
//  PageLayout), and the admin/* children add RequireAdmin.
//  The two template routes load their data in router
//  loaders, so a failed fetch renders ErrorPage instead of
//  a half-empty admin page.
//
//    /                        — Index (role-aware home)
//    /instances               — student instance list
//    /settings                — user settings
//    /home                    — About
//    /admin/templates[/:id]   — template admin (loaders)
//    /admin/users             — user admin
//    /admin/instances         — all-instances admin
//    /admin/guacamole         — Guacamole connections
//    /admin/proxmox-dashboard — Proxmox live view
//    /admin/lab-profiles      — lab profile admin
//    /admin/network           — network admin
//    /admin/settings          — settings admin
//
//  Used by:
//    - main.tsx — RouterProvider
// -----------------------------------------------------------

import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import axios from "axios";

const Index = lazy(() => import("@/pages/Index"));
const About = lazy(() => import("@/pages/About"));
const Login = lazy(() => import("@/pages/Login"));
const Privacy = lazy(() => import("@/pages/Privacy"));
const PageLayout = lazy(() => import("@/pages/PageLayout"));
const ErrorPage = lazy(() => import("@/pages/ErrorPage"));
const AdminTemplates = lazy(() => import("@/pages/admin/Templates"));
const AdminTemplateDetails = lazy(() => import("@/pages/admin/TemplateDetails"));
const AdminUsers = lazy(() => import("@/pages/admin/Users"));
const AdminGuacamole = lazy(() => import("@/pages/admin/Guacamole"));
const AdminProxmoxDashboard = lazy(() => import("@/pages/admin/ProxmoxDashboard"));
const AdminInstances = lazy(() => import("@/pages/admin/AdminInstances"));
const AdminSettings = lazy(() => import("@/pages/admin/Settings"));
const AdminLabProfiles = lazy(() => import("@/pages/admin/LabProfiles"));
const AdminNetwork = lazy(() => import("@/pages/admin/Network"));
const Instances = lazy(() => import("@/pages/Instances"));
const Settings = lazy(() => import("@/pages/Settings"));
import { AuthProvider, RequireAuth, RequireAdmin } from "@/utils/AuthGuard";
import { extractTemplate, extractTemplates } from "@/utils/templates";


// Shorthand Suspense wrapper — every lazy page renders through it.
const S = ({ children }: { children: React.ReactNode }) => (
    <Suspense fallback={null}>{children}</Suspense>
);


// Loader errors must be thrown as Response objects for the router to hand
// them to ErrorPage with a status; axios errors are translated here.
const toRouteError = (err: unknown, fallbackStatus = 500) => {
    if (err instanceof Response) {
        return err;
    }
    if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? fallbackStatus;
        const message =
            typeof err.response?.data?.error === "string"
                ? err.response.data.error
                : err.message;
        return new Response(message, { status, statusText: message });
    }
    if (err instanceof Error) {
        return new Response(err.message, {
            status: fallbackStatus,
            statusText: err.message,
        });
    }
    return new Response("Unexpected error", { status: fallbackStatus });
};


// Router loader for /admin/templates — the page renders from this data.
const templatesLoader = async () => {
    try {
        const response = await axios.get("/api/templates");
        const templates = extractTemplates(response.data);
        if (!templates) {
            throw new Response("Unexpected response from server.", {
                status: 500,
                statusText: "Unexpected response from server.",
            });
        }
        return templates;
    } catch (err) {
        throw toRouteError(err);
    }
};


// Router loader for /admin/templates/:id.
const templateDetailsLoader = async ({
    params,
}: {
    params: { id?: string };
}) => {
    try {
        if (!params.id) {
            throw new Response("Template ID is missing.", {
                status: 400,
                statusText: "Template ID is missing.",
            });
        }
        const response = await axios.get(`/api/templates/${params.id}`);
        const template = extractTemplate(response.data);
        if (!template) {
            throw new Response("Unexpected response from server.", {
                status: 500,
                statusText: "Unexpected response from server.",
            });
        }
        return template;
    } catch (err) {
        throw toRouteError(err);
    }
};


export const router = createBrowserRouter([
    {
        path: "/login",
        element: <S><Login /></S>,
        errorElement: <S><ErrorPage /></S>,
    },
    {
        path: "/privacy",
        element: <S><Privacy /></S>,
    },
    {
        path: "/",
        element: (
            <S>
                <AuthProvider>
                    <RequireAuth>
                        <PageLayout />
                    </RequireAuth>
                </AuthProvider>
            </S>
        ),
        errorElement: <S><ErrorPage /></S>,
        children: [
            { index: true, element: <S><Index /></S> },
            { path: "instances", element: <S><Instances /></S> },
            { path: "settings", element: <S><Settings /></S> },
            { path: "home", element: <S><About /></S> },
            {
                path: "admin/templates",
                element: <S><RequireAdmin><AdminTemplates /></RequireAdmin></S>,
                loader: templatesLoader,
            },
            {
                path: "admin/templates/:id",
                element: <S><RequireAdmin><AdminTemplateDetails /></RequireAdmin></S>,
                loader: templateDetailsLoader,
            },
            {
                path: "admin/users",
                element: <S><RequireAdmin><AdminUsers /></RequireAdmin></S>,
            },
            {
                path: "admin/instances",
                element: <S><RequireAdmin><AdminInstances /></RequireAdmin></S>,
            },
            {
                path: "admin/guacamole",
                element: <S><RequireAdmin><AdminGuacamole /></RequireAdmin></S>,
            },
            {
                path: "admin/proxmox-dashboard",
                element: <S><RequireAdmin><AdminProxmoxDashboard /></RequireAdmin></S>,
            },
            {
                path: "admin/lab-profiles",
                element: <S><RequireAdmin><AdminLabProfiles /></RequireAdmin></S>,
            },
            {
                path: "admin/network",
                element: <S><RequireAdmin><AdminNetwork /></RequireAdmin></S>,
            },
            {
                path: "admin/settings",
                element: <S><RequireAdmin><AdminSettings /></RequireAdmin></S>,
            },
        ],
    },
]);
