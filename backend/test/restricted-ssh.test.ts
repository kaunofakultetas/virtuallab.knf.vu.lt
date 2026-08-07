import assert from "node:assert/strict";
import test from "node:test";
import { RestrictedSshTransport } from "../src/network/adapters/restricted-ssh";

const fakeExecutable = `
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.mode === "timeout") return setTimeout(() => {}, 10_000);
    if (request.mode === "large") return process.stdout.write("x".repeat(100));
    process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), ...request }));
});
`;

function transport(executable: string, overrides: Partial<ConstructorParameters<typeof RestrictedSshTransport>[0]> = {}) {
    return new RestrictedSshTransport({
        executable,
        executableArgs: ["-e", fakeExecutable, "--"],
        host: "172.16.0.34",
        port: 2222,
        hostKeyAlias: "172.16.0.34",
        user: "virtual-lab-observer",
        identityFile: "/run/secrets/access-observer-key",
        knownHostsFile: "/app/config/access-known-hosts",
        remoteCommand: "virtual-lab-access-observe",
        executionTimeoutMs: 1_000,
        ...overrides,
    });
}

test("uses fixed hardened SSH arguments and sends only JSON on stdin", async () => {
    const result = await transport(process.execPath).execute({ request_id: "request-1" }) as {
        argv: string[];
        request_id: string;
    };

    assert.deepEqual(result.argv, [
        "-T",
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=/app/config/access-known-hosts",
        "-o", "HostKeyAlias=172.16.0.34",
        "-o", "ForwardAgent=no",
        "-o", "ClearAllForwardings=yes",
        "-o", "PermitLocalCommand=no",
        "-o", "ConnectTimeout=5",
        "-p", "2222",
        "-i", "/run/secrets/access-observer-key",
        "virtual-lab-observer@172.16.0.34",
        "virtual-lab-access-observe",
    ]);
    assert.equal(result.request_id, "request-1");
});

test("enforces execution timeout and output limits", async () => {
    await assert.rejects(
        transport(process.execPath, { executionTimeoutMs: 20 }).execute({ mode: "timeout" }),
        /timed out/,
    );
    await assert.rejects(
        transport(process.execPath, { maxOutputBytes: 8 }).execute({ mode: "large" }),
        /output exceeded/,
    );
});