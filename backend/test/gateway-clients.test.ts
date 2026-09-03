// -----------------------------------------------------------
//  [*] Tests — Gateway SSH channel construction
//
//  The optional observer (null when unconfigured) versus the
//  applier that refuses instead.
//
//  Covers src/network/gateway-clients.ts. Run with `npm
//  test` (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    createGatewayApplier,
    createGatewayObserver,
    GatewayClientConfigurationError,
} from "../src/network/gateway-clients";

function observerEnvironment(overrides: Record<string, string | undefined> = {}) {
    return {
        GATEWAY_OBSERVER_HOST: "exit",
        GATEWAY_OBSERVER_PORT: "2222",
        GATEWAY_OBSERVER_HOST_KEY_ALIAS: "172.16.0.34",
        GATEWAY_OBSERVER_USER: "root",
        GATEWAY_OBSERVER_IDENTITY_FILE: "/run/gateway-observer/id_ed25519",
        GATEWAY_OBSERVER_KNOWN_HOSTS_FILE: "/run/gateway-observer/known_hosts",
        ...overrides,
    } as NodeJS.ProcessEnv;
}

function applierEnvironment(overrides: Record<string, string | undefined> = {}) {
    return {
        GATEWAY_APPLIER_HOST: "exit",
        GATEWAY_APPLIER_PORT: "2222",
        GATEWAY_APPLIER_USER: "root",
        GATEWAY_APPLIER_IDENTITY_FILE: "/run/gateway-applier/id_ed25519",
        GATEWAY_APPLIER_KNOWN_HOSTS_FILE: "/run/gateway-applier/known_hosts",
        ...overrides,
    } as NodeJS.ProcessEnv;
}

test("an unconfigured observer returns null so the dry-run can degrade", () => {
    assert.equal(createGatewayObserver({} as NodeJS.ProcessEnv), null);
});

test("a partially configured observer returns null rather than a broken client", () => {
    const environment = observerEnvironment({ GATEWAY_OBSERVER_IDENTITY_FILE: undefined });
    assert.equal(createGatewayObserver(environment), null);
});

test("an identity file that is not an absolute path is rejected", () => {
    // A relative path would resolve against whatever the process cwd happens to
    // be, which is not something an SSH identity should depend on.
    const environment = observerEnvironment({ GATEWAY_OBSERVER_IDENTITY_FILE: "id_ed25519" });
    assert.equal(createGatewayObserver(environment), null);
});

test("a fully configured observer is constructed", () => {
    assert.ok(createGatewayObserver(observerEnvironment()));
});

test("an unconfigured applier throws instead of silently doing nothing", () => {
    // Every applier caller is an explicit mutation request, so returning null
    // and skipping the work would be worse than refusing.
    assert.throws(
        () => createGatewayApplier({} as NodeJS.ProcessEnv),
        GatewayClientConfigurationError,
    );
});

test("the applier error names the missing configuration", () => {
    const environment = applierEnvironment({ GATEWAY_APPLIER_USER: undefined });
    assert.throws(
        () => createGatewayApplier(environment),
        /GATEWAY_APPLIER_USER/,
    );
});

test("a fully configured applier is constructed", () => {
    assert.ok(createGatewayApplier(applierEnvironment()));
});

test("observer configuration alone does not configure the applier", () => {
    // The two principals are separate keys on purpose; one must never satisfy
    // the other's configuration.
    assert.throws(
        () => createGatewayApplier(observerEnvironment()),
        GatewayClientConfigurationError,
    );
});

test("applier configuration alone does not configure the observer", () => {
    assert.equal(createGatewayObserver(applierEnvironment()), null);
});
