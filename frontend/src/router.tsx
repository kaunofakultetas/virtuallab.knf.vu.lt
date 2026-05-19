import { createBrowserRouter } from "react-router-dom";

import Index from "@/pages/Index";
import About from "@/pages/About";
import Login from "@/pages/Login";
import PageLayout from "@/pages/PageLayout";
import ErrorPage from "@/pages/ErrorPage";
import { AuthProvider, RequireAuth } from "@/utils/AuthGuard";

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
        ],
    },
]);
