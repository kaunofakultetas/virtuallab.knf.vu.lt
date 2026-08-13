import assert from "node:assert/strict";
import test from "node:test";
import {
    createNetworkProxmoxMutator,
    createNetworkProxmoxObserver,
} from "../src/network/proxmox-clients";

const environmentKeys = [
    "PROXMOX_BASE_URL",
    "PROXMOX_NODE_NAME",
    "PROXMOX_TLS_INSECURE",
    "PROXMOX_NETWORK_OBSERVER_AUTH_TOKEN",
    "PROXMOX_NETWORK_MUTATOR_AUTH_TOKEN",
] as const;

function withEnvironment(values: Partial<Record<typeof environmentKeys[number], string>>, run: () => void) {
    const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    Object.assign(process.env, values);
    try {
        run();
    } finally {
        for (const key of environmentKeys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test("requires an explicit network observer token", () => {
    withEnvironment({
        PROXMOX_BASE_URL: "https://proxmox.example/api2/json",
        PROXMOX_NODE_NAME: "pve",
    }, () => {
        assert.throws(createNetworkProxmoxObserver, /PROXMOX_NETWORK_OBSERVER_AUTH_TOKEN/);
    });
});

test("requires an explicit network mutator token", () => {
    withEnvironment({
        PROXMOX_BASE_URL: "https://proxmox.example/api2/json",
        PROXMOX_NODE_NAME: "pve",
        PROXMOX_NETWORK_OBSERVER_AUTH_TOKEN: "observer",
    }, () => {
        assert.throws(createNetworkProxmoxMutator, /PROXMOX_NETWORK_MUTATOR_AUTH_TOKEN/);
    });
});

test("creates separate observer and mutator clients", () => {
    withEnvironment({
        PROXMOX_BASE_URL: "https://proxmox.example/api2/json",
        PROXMOX_NODE_NAME: "pve",
        PROXMOX_TLS_INSECURE: "true",
        PROXMOX_NETWORK_OBSERVER_AUTH_TOKEN: "observer",
        PROXMOX_NETWORK_MUTATOR_AUTH_TOKEN: "mutator",
    }, () => {
        const observer = createNetworkProxmoxObserver();
        const mutator = createNetworkProxmoxMutator();
        assert.notEqual(observer, mutator);
        void observer.close();
        void mutator.close();
    });
});