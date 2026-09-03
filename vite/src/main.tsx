// -----------------------------------------------------------
//  [*] App — browser entry point
//
//  Mounts the router inside the shared providers. Global
//  CSS and the Roboto weights load here, once, before any
//  page renders.
// -----------------------------------------------------------

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import "@/globals.css";
import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";

import AppProviders from "@/AppProviders";
import { router } from "@/router";


createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </StrictMode>,
);
