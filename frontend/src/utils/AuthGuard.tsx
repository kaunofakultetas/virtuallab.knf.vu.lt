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
