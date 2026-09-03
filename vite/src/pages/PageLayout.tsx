// -----------------------------------------------------------
//  [*] Pages — the signed-in page shell
//
//  Navbar on top, Sidebar on the left, the routed page in
//  the scrollable main area. Logout is shared with both
//  bars: clear the cookie server-side (failure ignored —
//  the redirect is what ends the session for the UI) and
//  go to /login.
//
//  Used by:
//    - router.tsx — the layout around every "/" child route
// -----------------------------------------------------------

import { Outlet, useNavigate } from "react-router-dom";
import axios from "axios";
import Box from "@mui/material/Box";
import { Navbar }  from "@/components/navigation/Navbar";
import { Sidebar } from "@/components/navigation/Sidebar";


export default function PageLayout() {
    const navigate = useNavigate();

    const handleLogout = async () => {
        await axios.post("/api/auth/logout").catch(() => {});
        navigate("/login");
    };

    return (
        <div className="h-screen flex flex-col overflow-hidden">
            <Navbar onLogout={handleLogout} />

            <div className="flex flex-1 overflow-hidden">
                <Sidebar onLogout={handleLogout} />

                <Box
                    component="main"
                    sx={{ flex: 1, overflow: "auto", bgcolor: "background.default", p: 3 }}
                >
                    <Outlet />
                </Box>
            </div>
        </div>
    );
}
