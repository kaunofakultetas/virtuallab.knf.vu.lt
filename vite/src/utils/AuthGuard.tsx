// -----------------------------------------------------------
//  [*] Utils — session context and route guards
//
//  The session is fetched ONCE (GET /api/auth) by
//  AuthProvider and shared through context; a failed fetch
//  hard-navigates to /login, so no guarded page ever
//  renders unauthenticated. RequireAuth renders nothing
//  until the session arrives; RequireAdmin additionally
//  shows an access-restricted panel to non-admins instead
//  of the page.
//
//  Split into (guards last):
//
//    useAuth       — the context reader
//    AuthProvider  — fetches and provides the session
//    RequireAuth   — session gate
//    RequireAdmin  — role gate
//
//  Used by:
//    - router.tsx — wraps the "/" tree and admin routes
//    - Navbar.tsx, Sidebar.tsx, pages — useAuth
// -----------------------------------------------------------

/* eslint-disable react-refresh/only-export-components */

import { useNavigate } from "react-router-dom";
import axios from "axios";
import React, { useEffect, createContext, useContext } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";

const AuthContext = createContext<AuthDataPayload | null>(null);

export interface AuthDataPayload {
    vu_id: string;
    role: string;
    last_login?: string | null;
    has_password?: boolean;
}


export function useAuth() {
    return useContext(AuthContext);
}

interface AuthProviderProps {
    children: React.ReactNode;
}








// -----------------------------------------------------------
// AuthProvider
// -----------------------------------------------------------
//
// window.location, not navigate: this can fire outside a
// router context, and a hard navigation also drops any
// stale in-memory state along with the dead session.
//
// Used by:
//   - router.tsx — around PageLayout
// -----------------------------------------------------------

export const AuthProvider = ({ children }: AuthProviderProps) => {
    const [authData, setAuthData] = React.useState<AuthDataPayload | null>(
        null,
    );

    useEffect(() => {
        axios
            .get("/api/auth")
            .then((response) => {
                setAuthData(response.data);
            })
            .catch(() => {
                window.location.href = "/login";
            });
    }, []);

    return (
        <AuthContext.Provider value={authData}>{children}</AuthContext.Provider>
    );
};

interface RequireAuthProps {
    children: React.ReactNode;
}








// -----------------------------------------------------------
// RequireAuth
// -----------------------------------------------------------
//
// Nothing renders while the session is still loading — the
// provider's catch handles the failure case.
//
// Used by:
//   - router.tsx — around PageLayout
// -----------------------------------------------------------

export const RequireAuth = ({ children }: RequireAuthProps) => {
    const authData = useAuth();

    if (!authData) {
        return null;
    }

    return <>{children}</>;
};

interface RequireAdminProps {
    children: React.ReactNode;
}








// -----------------------------------------------------------
// RequireAdmin
// -----------------------------------------------------------
//
// Cosmetic only — every admin API rechecks the role
// server-side; this just spares non-admins a page of
// failing requests.
//
// Used by:
//   - router.tsx — around every admin/* route
// -----------------------------------------------------------

export const RequireAdmin = ({ children }: RequireAdminProps) => {
    const authData = useAuth();
    const navigate = useNavigate();

    if (!authData) {
        return null;
    }

    if (authData.role !== "admin") {
        return (
            <Box
                sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    minHeight: 360,
                    gap: 1.5,
                }}
            >
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                    Access restricted
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    You need admin permissions to view this page.
                </Typography>
                <Button variant="contained" onClick={() => navigate("/")}>
                    Back to dashboard
                </Button>
            </Box>
        );
    }

    return <>{children}</>;
};
