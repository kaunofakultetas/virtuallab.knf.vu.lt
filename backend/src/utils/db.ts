// -----------------------------------------------------------
//  [*] Utils — the shared PostgreSQL pool
//
//  One pg Pool for the whole backend, configured from
//  DATABASE_URL. Pool errors are logged, not thrown: an
//  idle client dying must not take the process down.
//
//  Used by:
//    - nearly every controller, route and network module
//    - index.ts — closed last on shutdown, after the server
// -----------------------------------------------------------

import pg from "pg";
import { logger } from "@/utils/logger";

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
    logger.error(err, "database pool error");
});
