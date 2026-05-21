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
    "settings.network.insideIpPrefix": "10.10.",
    "settings.instances.ipWaitTimeoutMs": 60_000,
    "settings.instances.ipPollIntervalMs": 2_000,
    "settings.proxmox.minVmId": 10_000,
    "settings.instances.defaultRuntimeHours": 3,
    "settings.guacamole.parentIdentifier": "1",
    "settings.guacamole.requestTimeoutMs": 10_000,
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

async function getAll(): Promise<
    Array<{
        key: string;
        value: MetaValue;
        default: MetaValue;
        updated_at: Date | null;
    }>
> {
    const { rows } = await pool.query<{
        key: string;
        value: MetaValue;
        updated_at: Date;
    }>("SELECT key, value, updated_at FROM metadata WHERE key = ANY($1)", [
        Object.keys(defaults),
    ]);
    const dbMap = new Map(rows.map((r) => [r.key, r]));

    return Object.entries(defaults).map(([key, defaultValue]) => {
        const row = dbMap.get(key);
        return {
            key,
            value: row?.value ?? defaultValue,
            default: defaultValue,
            updated_at: row?.updated_at ?? null,
        };
    });
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
    getAll,
    initDefaults,
};
