// -----------------------------------------------------------
//  [*] Scripts — preflight-network-tokens (operator CLI)
//
//  Proves the two network Proxmox tokens hold exactly the
//  privileges the design assumes, by exercising them: the
//  observer must read SDN but be refused a write, the
//  mutator must create/apply/delete a disposable VNet but
//  be unable to enumerate VMs or storage. Any assertion
//  failure is a mis-scoped token, caught before the first
//  real reconciliation runs.
//
//  Usage:
//    npm run preflight-network-tokens   (env vars only)
// -----------------------------------------------------------

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Agent, request as httpRequest } from "undici";

type RequestResult = {
    status: number;
    body: unknown;
};


function requiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}`);
    return value;
}


const configuredBaseUrl = requiredEnvironment("PROXMOX_BASE_URL").replace(/\/$/, "");
const baseUrl = configuredBaseUrl.endsWith("/api2/json")
    ? configuredBaseUrl
    : `${configuredBaseUrl}/api2/json`;
const nodeName = requiredEnvironment("PROXMOX_NODE_NAME");
const observerToken = requiredEnvironment("PROXMOX_NETWORK_OBSERVER_AUTH_TOKEN");
const mutatorToken = requiredEnvironment("PROXMOX_NETWORK_MUTATOR_AUTH_TOKEN");
// Proxmox rejects SDN VNet names longer than 8 characters, so the disposable
// name is a "vlp" marker plus 5 random hex characters. Production names are
// "lab<vlan-tag>", so a leftover "vlp*" VNet is always preflight residue.
const vnet = `vlp${randomBytes(3).toString("hex").slice(0, 5)}`;
const dispatcher = new Agent({
    connect: {
        rejectUnauthorized: process.env.PROXMOX_TLS_INSECURE !== "true",
    },
});


async function request(
    token: string,
    path: string,
    method = "GET",
    form?: URLSearchParams,
): Promise<RequestResult> {
    const response = await httpRequest(`${baseUrl}${path}`, {
        method,
        dispatcher,
        headers: {
            Authorization: `PVEAPIToken=${token}`,
            ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form?.toString(),
    });
    const body = await response.body.json().catch(() => null);
    return { status: response.statusCode, body };
}


// Proxmox list endpoints do not answer 403 for an unprivileged token; they
// answer 200 with the result set filtered down to what the token may see. A
// bare status check would therefore read as an escalation when none exists.
// Treat "denied" as an explicit 403 or an empty result set, and report only the
// entry count so no VM or storage identifier is ever printed.
function entryCount(result: RequestResult): number {
    const data = (result.body as { data?: unknown } | null)?.data;
    return Array.isArray(data) ? data.length : 0;
}


function isDenied(result: RequestResult): boolean {
    if (result.status === 403) return true;
    return result.status === 200 && entryCount(result) === 0;
}


async function main(): Promise<void> {
    let created = false;
    try {
        const observerRead = await request(observerToken, "/cluster/sdn/vnets");
        const observerWrite = await request(
            observerToken,
            "/cluster/sdn/vnets",
            "POST",
            new URLSearchParams({ vnet, zone: "labzone", tag: "2255" }),
        );
        // A successful observer write is a privilege-separation failure, but it still
        // creates the VNet. Track it so cleanup runs on exactly the path that must not
        // leave residue behind.
        created = observerWrite.status === 200;
        const mutatorCreate = await request(
            mutatorToken,
            "/cluster/sdn/vnets",
            "POST",
            new URLSearchParams({ vnet, zone: "labzone", tag: "2255" }),
        );
        created ||= mutatorCreate.status === 200;
        const mutatorApply = await request(mutatorToken, "/cluster/sdn", "PUT");
        const mutatorRead = await request(mutatorToken, `/cluster/sdn/vnets/${vnet}`);
        const vmRead = await request(mutatorToken, `/nodes/${nodeName}/qemu`);
        const storageRead = await request(mutatorToken, `/nodes/${nodeName}/storage`);
        const mutatorDelete = await request(
            mutatorToken,
            `/cluster/sdn/vnets/${vnet}`,
            "DELETE",
        );
        if (mutatorDelete.status === 200) created = false;
        const mutatorApplyDelete = await request(mutatorToken, "/cluster/sdn", "PUT");
        const finalRead = await request(mutatorToken, `/cluster/sdn/vnets/${vnet}`);

        const statuses = {
            observer_read: observerRead.status,
            observer_write: observerWrite.status,
            mutator_create: mutatorCreate.status,
            mutator_apply: mutatorApply.status,
            mutator_read: mutatorRead.status,
            vm_read: vmRead.status,
            storage_read: storageRead.status,
            mutator_delete: mutatorDelete.status,
            mutator_apply_delete: mutatorApplyDelete.status,
            final_read: finalRead.status,
        };
        for (const [name, status] of Object.entries(statuses)) {
            console.log(`${name}=${status}`);
        }
        console.log(`vm_read_entries=${entryCount(vmRead)}`);
        console.log(`storage_read_entries=${entryCount(storageRead)}`);

        assert.equal(observerRead.status, 200);
        assert.equal(observerWrite.status, 403);
        assert.equal(mutatorCreate.status, 200);
        assert.equal(mutatorApply.status, 200);
        assert.equal(mutatorRead.status, 200);
        assert.ok(isDenied(vmRead), `mutator token can enumerate VMs (${entryCount(vmRead)} entries)`);
        assert.ok(
            isDenied(storageRead),
            `mutator token can enumerate storage (${entryCount(storageRead)} entries)`,
        );
        assert.equal(mutatorDelete.status, 200);
        assert.equal(mutatorApplyDelete.status, 200);
        assert.notEqual(finalRead.status, 200);
    } finally {
        if (created) {
            await request(mutatorToken, `/cluster/sdn/vnets/${vnet}`, "DELETE").catch(() => null);
            await request(mutatorToken, "/cluster/sdn", "PUT").catch(() => null);
        }
    }
}


main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Network token preflight failed");
    process.exitCode = 1;
}).finally(async () => {
    await dispatcher.close();
});
