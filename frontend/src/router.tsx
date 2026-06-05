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
const Instances = lazy(() => import("@/pages/Instances"));
import { AuthProvider, RequireAuth, RequireAdmin } from "@/utils/AuthGuard";
import { extractTemplate, extractTemplates } from "@/utils/templates";

const S = ({ children }: { children: React.ReactNode }) => (
    <Suspense fallback={null}>{children}</Suspense>
);

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
                path: "admin/settings",
                element: <S><RequireAdmin><AdminSettings /></RequireAdmin></S>,
            },
        ],
    },
]);
