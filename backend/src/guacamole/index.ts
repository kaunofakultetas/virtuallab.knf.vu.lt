// -----------------------------------------------------------
//  [*] Guacamole — the app-wide client singleton
//
//  One GuacamoleClient built from the GUACAMOLE_* env vars.
//  publicUrl is what students' browsers can reach; baseUrl
//  is what the backend dials inside the stack.
//
//  Used by:
//    - instances (controller + route), users.controller.ts,
//      metrics-poller.ts
// -----------------------------------------------------------

import { GuacamoleClient } from "./api";

export const guacamole = new GuacamoleClient({
    baseUrl: process.env.GUACAMOLE_URL!,
    publicUrl: process.env.GUACAMOLE_PUBLIC_URL,
    username: process.env.GUACAMOLE_USER!,
    password: process.env.GUACAMOLE_PASS!,
    rejectUnauthorized: process.env.GUACAMOLE_TLS_INSECURE !== "true",
});
