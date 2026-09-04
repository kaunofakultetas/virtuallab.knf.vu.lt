// -----------------------------------------------------------
//  [*] Utils — metadata: the JSONB key/value settings store
//
//  Typed access to the `metadata` table, where every tunable
//  the admin UI exposes lives as a dotted key with a JSONB
//  value. `defaults` is the catalogue: getAll() reports
//  exactly these keys (value falling back to the default),
//  and initDefaults() seeds them without overwriting what an
//  operator already changed.
//
//  Everything is exported as one `metadata` object at the
//  bottom (defaults, get, set, del, list, getAll,
//  initDefaults).
//
//  Used by:
//    - index.ts — initDefaults() on boot
//    - metadata.route.ts — the admin settings UI
//    - network/mode.ts, network/gateway-plan.ts — network
//      settings reads
//    - instances (controller + route), guacamole/api.ts —
//      per-feature limits and timeouts
//    - scripts/setGatewayRuntimeSettings.ts — the operator
//      CLI for the gateway.* keys
// -----------------------------------------------------------

import { pool } from "./db";


export type MetaValue =
    | string
    | number
    | boolean
    | null
    | MetaValue[]
    | { [k: string]: MetaValue };








// -----------------------------------------------------------
// defaults
// -----------------------------------------------------------
//
// The catalogue of known settings. getAll() and
// initDefaults() iterate this, so a key missing here is
// invisible to the admin UI even if set in the DB.
//
// Used by:
//   - getAll, initDefaults (below)
//   - metadata.route.ts — type-checks writes against the
//     default's shape
// -----------------------------------------------------------

const defaults: Record<string, MetaValue> = {
    "settings.limits.vmPerStudent": 1,
    "settings.network.mode": "legacy",
    "settings.network.insideIpPrefix": "10.10.",
    "settings.instances.ipWaitTimeoutMs": 60_000,
    "settings.instances.ipPollIntervalMs": 2_000,
    "settings.proxmox.minVmId": 10_000,
    "settings.proxmox.storageReserveBytes": 2_147_483_648,
    "settings.instances.defaultRuntimeHours": 3,
    // Ceiling on an instance's TOTAL life, measured from created_at.
    // defaultRuntimeHours sets the initial window and bounds nothing after
    // it: /renew reset run_until to now + default with no cap, so a loop
    // kept a VM forever and the expiry sweeper never reclaimed it.
    "settings.limits.maxRuntimeHours": 24,
    "settings.guacamole.parentIdentifier": "1",
    "settings.guacamole.requestTimeoutMs": 10_000,
    // Gateway guest facts that cannot be derived from the database. They stay
    // empty until the VM exists and its real interface names are observed;
    // reading them fails closed, so policy is never rendered against guessed
    // names.
    "settings.network.gateway.trunkInterface": "",
    "settings.network.gateway.uplinkInterface": "",
    "settings.network.gateway.managementInterface": "",
    "settings.network.gateway.upstreamResolvers": [],
};








// -----------------------------------------------------------
// get
// -----------------------------------------------------------
//
// One value by key, or undefined — defaults are NOT applied
// here; callers that want the fallback go through getAll()
// or supply their own.
//
// Used by:
//   - every metadata.get() caller listed in the header
// -----------------------------------------------------------

async function get<T extends MetaValue = MetaValue>(
    key: string,
): Promise<T | undefined> {
    const { rows } = await pool.query<{ value: T }>(
        "SELECT value FROM metadata WHERE key = $1",
        [key],
    );
    return rows[0]?.value;
}








// -----------------------------------------------------------
// set
// -----------------------------------------------------------
//
// Upsert with updated_at bumped, so the admin UI can show
// when a setting last changed.
//
// Used by:
//   - metadata.route.ts — the admin settings write path
//   - scripts/setGatewayRuntimeSettings.ts
// -----------------------------------------------------------

async function set(key: string, value: MetaValue): Promise<void> {
    await pool.query(
        `INSERT INTO metadata (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
    );
}








// -----------------------------------------------------------
// del
// -----------------------------------------------------------
//
// True when a row was actually deleted.
//
// Used by:
//   - metadata.route.ts — resetting a key to its default
// -----------------------------------------------------------

async function del(key: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        "DELETE FROM metadata WHERE key = $1",
        [key],
    );
    return (rowCount ?? 0) > 0;
}








// -----------------------------------------------------------
// list
// -----------------------------------------------------------
//
// Keys only, optionally filtered by prefix.
//
// Used by:
//   - metadata.route.ts
// -----------------------------------------------------------

async function list(prefix?: string): Promise<string[]> {
    const { rows } = await pool.query<{ key: string }>(
        prefix
            ? "SELECT key FROM metadata WHERE key LIKE $1 ORDER BY key"
            : "SELECT key FROM metadata ORDER BY key",
        prefix ? [prefix + "%"] : [],
    );
    return rows.map((r) => r.key);
}








// -----------------------------------------------------------
// getAll
// -----------------------------------------------------------
//
// Every catalogued setting with its stored value (or the
// default when the row is absent) — the shape the admin
// settings page renders directly.
//
// Used by:
//   - metadata.route.ts — GET the settings list
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// initDefaults
// -----------------------------------------------------------
//
// Seeds every default in one statement; DO NOTHING keeps
// operator-changed values intact across restarts.
//
// Used by:
//   - index.ts — once on boot, before the server listens
// -----------------------------------------------------------

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
