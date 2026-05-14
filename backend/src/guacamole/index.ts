import { GuacamoleClient } from "./api";

export const guacamole = new GuacamoleClient({
    baseUrl: process.env.GUACAMOLE_URL!,
    publicUrl: process.env.GUACAMOLE_PUBLIC_URL,
    username: process.env.GUACAMOLE_USER!,
    password: process.env.GUACAMOLE_PASS!,
    rejectUnauthorized: process.env.GUACAMOLE_TLS_INSECURE !== "true",
});
