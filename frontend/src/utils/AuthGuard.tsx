/* eslint-disable react-refresh/only-export-components */

import axios from "axios";
import React, { useEffect, createContext, useContext } from "react";

const AuthContext = createContext<AuthDataPayload | null>(null);

export interface AuthDataPayload {
    vu_id: string;
    role: string;
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
