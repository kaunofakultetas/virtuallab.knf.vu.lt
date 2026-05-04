import pg from 'pg';
import { logger } from '@/utils/logger';

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
    logger.error(err, "database pool error");
});