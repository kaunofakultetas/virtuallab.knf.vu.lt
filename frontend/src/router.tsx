import { createBrowserRouter } from "react-router-dom";
import axios from "axios";

import Index from "@/pages/Index";
import About from "@/pages/About";
import Login from "@/pages/Login";
import PageLayout from "@/pages/PageLayout";
import ErrorPage from "@/pages/ErrorPage";
import AdminTemplates from "@/pages/admin/Templates";
import AdminTemplateDetails from "@/pages/admin/TemplateDetails";
import { AuthProvider, RequireAuth, RequireAdmin } from "@/utils/AuthGuard";
import { extractTemplate, extractTemplates } from "@/utils/templates";

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
        element: <Login />,
        errorElement: <ErrorPage />,
    },
    {
        path: "/",
        element: (
            <AuthProvider>
                <RequireAuth>
                    <PageLayout />
                </RequireAuth>
            </AuthProvider>
        ),
        errorElement: <ErrorPage />,
        children: [
            { index: true, element: <Index /> },
            { path: "home", element: <About /> },
            {
                path: "admin/templates",
                element: (
                    <RequireAdmin>
                        <AdminTemplates />
                    </RequireAdmin>
                ),
                loader: templatesLoader,
            },
            {
                path: "admin/templates/:id",
                element: (
                    <RequireAdmin>
                        <AdminTemplateDetails />
                    </RequireAdmin>
                ),
                loader: templateDetailsLoader,
            },
        ],
    },
]);
