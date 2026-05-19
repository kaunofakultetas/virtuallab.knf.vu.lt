import { pool } from "./db";

export type MetaValue =
    | string
    | number
    | boolean
    | null
    | MetaValue[]
    | { [k: string]: MetaValue };

const defaults: Record<string, MetaValue> = {
    "settings.limits.vmPerStudent": 1,
};

async function get<T extends MetaValue = MetaValue>(
    key: string,
): Promise<T | undefined> {
    const { rows } = await pool.query<{ value: T }>(
        "SELECT value FROM metadata WHERE key = $1",
        [key],
    );
    return rows[0]?.value;
}

async function set(key: string, value: MetaValue): Promise<void> {
    await pool.query(
        `INSERT INTO metadata (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
    );
}

async function del(key: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        "DELETE FROM metadata WHERE key = $1",
        [key],
    );
    return (rowCount ?? 0) > 0;
}

async function list(prefix?: string): Promise<string[]> {
    const { rows } = await pool.query<{ key: string }>(
        prefix
            ? "SELECT key FROM metadata WHERE key LIKE $1 ORDER BY key"
            : "SELECT key FROM metadata ORDER BY key",
        prefix ? [prefix + "%"] : [],
    );
    return rows.map((r) => r.key);
}

async function initDefaults(): Promise<void> {
    const entries = Object.entries(defaults);
    if (entries.length === 0) return;

    const values: string[] = [];
    const params: unknown[] = [];
    entries.forEach(([k, v], i) => {
        values.push(`($${i * 2 + 1}, $${i * 2 + 2}::jsonb)`);
        params.push(k, JSON.stringify(v));
    });

    await pool.query(
        `INSERT INTO metadata (key, value)
         VALUES ${values.join(", ")}
         ON CONFLICT (key) DO NOTHING`,
        params,
    );
}

export const metadata = {
    defaults,
    get,
    set,
    del,
    list,
    initDefaults,
};
