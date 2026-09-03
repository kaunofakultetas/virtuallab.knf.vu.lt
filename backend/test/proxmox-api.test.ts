// -----------------------------------------------------------
//  [*] Tests — the Proxmox HTTP client
//
//  Auth-header forms, GET retries, hyphen-to-underscore key
//  rewriting and task waiting.
//
//  Covers src/proxmox/api.ts. Run with `npm test` (the whole
//  suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { AddressInfo } from "node:net";
import { ProxmoxClient } from "../src/proxmox/api";
import {
    ProxmoxApiError,
    ProxmoxNodeTaskStatus,
    ProxmoxTaskError,
    ProxmoxTaskTimeoutError,
} from "../src/proxmox/types";

type RecordedRequest = {
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    form: Record<string, string>;
};

async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
}

async function startFixture(
    respond: (
        request: RecordedRequest,
        response: ServerResponse,
        requestNumber: number,
    ) => void,
    authToken = "root@pam!backend=secret",
) {
    const requests: RecordedRequest[] = [];
    const server = createServer(async (incoming, response) => {
        const request = {
            method: incoming.method ?? "",
            url: incoming.url ?? "",
            headers: incoming.headers,
            form: await readForm(incoming),
        };
        requests.push(request);
        respond(request, response, requests.length);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = new ProxmoxClient({
        baseUrl: `http://127.0.0.1:${port}`,
        nodeName: "pve/test",
        authToken,
    });

    return {
        client,
        requests,
        async close() {
            await client.close();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => error ? reject(error) : resolve()),
            );
        },
    };
}

function sendData(response: ServerResponse, data: unknown): void {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data }));
}

test("encodes SDN VNet and subnet operations", async () => {
    const fixture = await startFixture((_request, response) => sendData(response, null));
    try {
        await fixture.client.createSdnVnet({
            vnet: "lab2000",
            zone: "labzone",
            tag: 2000,
            vlanaware: false,
        });
        await fixture.client.updateSdnSubnet("lab/2000", "lab2000-10.200.0.0-24", {
            gateway: "10.200.0.1",
            snat: false,
            digest: "abc123",
        });
        const applyResult = await fixture.client.applySdnConfiguration();

        assert.equal(applyResult, null);
        assert.deepEqual(fixture.requests.map(({ method, url }) => ({ method, url })), [
            { method: "POST", url: "/api2/json/cluster/sdn/vnets" },
            {
                method: "PUT",
                url: "/api2/json/cluster/sdn/vnets/lab%2F2000/subnets/lab2000-10.200.0.0-24",
            },
            { method: "PUT", url: "/api2/json/cluster/sdn" },
        ]);
        assert.deepEqual(fixture.requests[0].form, {
            vnet: "lab2000",
            zone: "labzone",
            tag: "2000",
            vlanaware: "0",
        });
        assert.deepEqual(fixture.requests[1].form, {
            gateway: "10.200.0.1",
            snat: "0",
            digest: "abc123",
        });
        assert.equal(fixture.requests[0].headers.authorization, "PVEAPIToken=root@pam!backend=secret");
    } finally {
        await fixture.close();
    }
});

test("preserves an asynchronous SDN apply UPID", async () => {
    const fixture = await startFixture((_request, response) =>
        sendData(response, "UPID:pve:00000001"),
    );
    try {
        assert.equal(
            await fixture.client.applySdnConfiguration(),
            "UPID:pve:00000001",
        );
    } finally {
        await fixture.close();
    }
});

test("preserves complete QEMU and LXC network strings", async () => {
    const fixture = await startFixture((_request, response) => sendData(response, null));
    try {
        const network = "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr20,firewall=1,trunks=2000;2001";
        await fixture.client.updateVmConfig("202", { net1: network, digest: "vm-digest" });
        await fixture.client.updateContainerConfig("200", {
            net1: "name=eth1,bridge=vmbr20,trunks=2000;2001",
        });

        assert.deepEqual(fixture.requests.map(({ method, url, form }) => ({ method, url, form })), [
            {
                method: "PUT",
                url: "/api2/json/nodes/pve%2Ftest/qemu/202/config",
                form: { net1: network, digest: "vm-digest" },
            },
            {
                method: "PUT",
                url: "/api2/json/nodes/pve%2Ftest/lxc/200/config",
                form: { net1: "name=eth1,bridge=vmbr20,trunks=2000;2001" },
            },
        ]);
    } finally {
        await fixture.close();
    }
});

test("encodes cluster firewall groups, IPSets, and entries", async () => {
    const fixture = await startFixture((_request, response) => sendData(response, null));
    try {
        await fixture.client.createFirewallSecurityGroup({
            group: "lab-web",
            comment: "student web policy",
        });
        await fixture.client.updateFirewallSecurityGroup("lab/web", {
            comment: "updated policy",
            digest: "metadata-digest",
        });
        await fixture.client.updateFirewallSecurityGroupRule("lab/web", 2, {
            type: "in",
            action: "ACCEPT",
            proto: "tcp",
            dport: "443",
            enable: true,
            "icmp-type": undefined,
            digest: "group-digest",
        });
        await fixture.client.createFirewallIpSet({ name: "lab_access" });
        await fixture.client.updateFirewallIpSetEntry("lab/access", "10.200.0.2/32", {
            cidr: "10.200.0.3/32",
            nomatch: false,
            digest: "ipset-digest",
        });

        assert.deepEqual(fixture.requests.map(({ method, url }) => ({ method, url })), [
            { method: "POST", url: "/api2/json/cluster/firewall/groups" },
            { method: "PUT", url: "/api2/json/cluster/firewall/groups/lab%2Fweb" },
            { method: "PUT", url: "/api2/json/cluster/firewall/groups/lab%2Fweb/2" },
            { method: "POST", url: "/api2/json/cluster/firewall/ipset" },
            {
                method: "PUT",
                url: "/api2/json/cluster/firewall/ipset/lab%2Faccess/10.200.0.2%2F32",
            },
        ]);
        assert.deepEqual(fixture.requests[1].form, {
            comment: "updated policy",
            digest: "metadata-digest",
        });
        assert.deepEqual(fixture.requests[2].form, {
            type: "in",
            action: "ACCEPT",
            proto: "tcp",
            dport: "443",
            enable: "1",
            digest: "group-digest",
        });
        assert.deepEqual(fixture.requests[4].form, {
            cidr: "10.200.0.3/32",
            nomatch: "0",
            digest: "ipset-digest",
        });
    } finally {
        await fixture.close();
    }
});

test("encodes QEMU firewall rules and options", async () => {
    const fixture = await startFixture((_request, response) => sendData(response, null));
    try {
        await fixture.client.createVmFirewallRule("300", {
            type: "group",
            action: "lab-web",
            enable: true,
        });
        await fixture.client.updateVmFirewallOptions("300", {
            enable: true,
            policy_in: "DROP",
            digest: "vm-firewall-digest",
        });
        await fixture.client.deleteVmFirewallRule("300", 4, "vm-firewall-digest");

        assert.deepEqual(fixture.requests.map(({ method, url, form }) => ({ method, url, form })), [
            {
                method: "POST",
                url: "/api2/json/nodes/pve%2Ftest/qemu/300/firewall/rules",
                form: { type: "group", action: "lab-web", enable: "1" },
            },
            {
                method: "PUT",
                url: "/api2/json/nodes/pve%2Ftest/qemu/300/firewall/options",
                form: { enable: "1", policy_in: "DROP", digest: "vm-firewall-digest" },
            },
            {
                method: "DELETE",
                url: "/api2/json/nodes/pve%2Ftest/qemu/300/firewall/rules/4",
                form: { digest: "vm-firewall-digest" },
            },
        ]);
    } finally {
        await fixture.close();
    }
});

test("unwraps task completion and reports non-OK and timeout outcomes", async () => {
    let taskRequest = 0;
    const fixture = await startFixture((_request, response) => {
        taskRequest += 1;
        const task: ProxmoxNodeTaskStatus = {
            id: "1",
            node: "pve",
            pid: 1,
            pstart: 1,
            pstarttime: 1,
            status: taskRequest === 1 ? "running" : "stopped",
            type: "test",
            upid: "UPID:pve:1",
            user: "root@pam",
            exitstatus: taskRequest === 1 ? undefined : "OK",
        };
        sendData(response, task);
    });
    try {
        const task = await fixture.client.waitForTask("UPID:pve:1", {
            timeoutMs: 100,
            pollIntervalMs: 1,
        });
        assert.equal(task.exitstatus, "OK");
        assert.equal(
            fixture.requests[0].url,
            "/api2/json/nodes/pve%2Ftest/tasks/UPID%3Apve%3A1/status",
        );
    } finally {
        await fixture.close();
    }

    const failed = await startFixture((_request, response) => sendData(response, {
        id: "2", node: "pve", pid: 1, pstart: 1, pstarttime: 1,
        status: "stopped", type: "test", upid: "UPID:pve:2",
        user: "root@pam", exitstatus: "storage unavailable",
    }));
    try {
        await assert.rejects(
            failed.client.waitForTask("UPID:pve:2", { timeoutMs: 50 }),
            (error: unknown) => error instanceof ProxmoxTaskError
                && error.task.exitstatus === "storage unavailable",
        );
    } finally {
        await failed.close();
    }

    const timedOut = await startFixture((_request, response) => sendData(response, {
        id: "3", node: "pve", pid: 1, pstart: 1, pstarttime: 1,
        status: "running", type: "test", upid: "UPID:pve:3", user: "root@pam",
    }));
    try {
        await assert.rejects(
            timedOut.client.waitForTask("UPID:pve:3", {
                timeoutMs: 5,
                pollIntervalMs: 1,
            }),
            ProxmoxTaskTimeoutError,
        );
    } finally {
        await timedOut.close();
    }
});

test("keeps the legacy boolean task waiter compatible", async () => {
    const fixture = await startFixture((_request, response) => sendData(response, {
        id: "4", node: "pve", pid: 1, pstart: 1, pstarttime: 1,
        status: "stopped", type: "test", upid: "UPID:pve:4",
        user: "root@pam", exitstatus: "OK",
    }));
    try {
        assert.equal(await fixture.client.waitForTaskCompletion("UPID:pve:4"), true);
    } finally {
        await fixture.close();
    }
});

test("retries GET failures but sends mutations once", async () => {
    const getFixture = await startFixture((_request, response, requestNumber) => {
        if (requestNumber === 1) {
            response.writeHead(401, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ errors: "expired" }));
            return;
        }
        sendData(response, { vnet: "lab2000", zone: "labzone", tag: 2000 });
    });
    try {
        assert.equal((await getFixture.client.getSdnVnet("lab2000")).tag, 2000);
        assert.equal(getFixture.requests.length, 2);
    } finally {
        await getFixture.close();
    }

    const mutationFixture = await startFixture((_request, response) => {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ errors: "temporarily unavailable" }));
    });
    try {
        await assert.rejects(
            mutationFixture.client.createSdnVnet({
                vnet: "lab2000",
                zone: "labzone",
            }),
            ProxmoxApiError,
        );
        assert.equal(mutationFixture.requests.length, 1);
    } finally {
        await mutationFixture.close();
    }
});

test("normalizes cookie authentication and exposes API error details", async () => {
    const fixture = await startFixture((request, response) => {
        assert.equal(request.headers.cookie, "PVEAuthCookie=ticket-value");
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ errors: { vnet: "invalid name" } }));
    }, "ticket-value");
    try {
        await assert.rejects(
            fixture.client.getSdnVnet("bad/name"),
            (error: unknown) => error instanceof ProxmoxApiError
                && error.status === 400
                && error.path === "/cluster/sdn/vnets/bad%2Fname"
                && assert.deepEqual(error.details, { errors: { vnet: "invalid name" } }) === undefined,
        );
        assert.equal(fixture.requests.length, 1);
    } finally {
        await fixture.close();
    }
});