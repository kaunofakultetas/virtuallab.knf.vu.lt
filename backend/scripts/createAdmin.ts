import bcrypt from "bcryptjs";
import pg from "pg";

function getVuId(): string {
    const args = process.argv.slice(2);
    const vuIdIndex = args.findIndex(
        (arg) => arg === "--vu-id" || arg === "--username" || arg === "-u",
    );
    const vuId = vuIdIndex >= 0 ? args[vuIdIndex + 1] : undefined;

    if (!vuId) {
        throw new Error("Usage: npm run create-admin -- --vu-id <numeric-id>");
    }
    if (!/^\d+$/.test(vuId)) {
        throw new Error("vu_id must contain digits only");
    }

    return vuId;
}

async function main() {
    const vuId = getVuId();
    const password = process.env.ADMIN_PASSWORD;
    const databaseUrl = process.env.DATABASE_URL;

    if (!password) {
        throw new Error("Set ADMIN_PASSWORD in the command environment");
    }
    if (!databaseUrl) {
        throw new Error("DATABASE_URL is not set");
    }

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        await client.query(
            `INSERT INTO users (vu_id, password, role)
             VALUES ($1, $2, 'admin')
             ON CONFLICT (vu_id) DO UPDATE
             SET password = EXCLUDED.password, role = 'admin'`,
            [vuId, passwordHash],
        );
        console.log(`Admin account ready: ${vuId}`);
    } finally {
        await client.end();
    }
}

void main().catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
});