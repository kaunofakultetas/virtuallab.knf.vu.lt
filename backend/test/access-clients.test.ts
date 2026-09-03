// -----------------------------------------------------------
//  [*] Tests — Access SSH channel construction
//
//  The three Access principals built from environment, and
//  the refusals when configuration is missing.
//
//  Covers src/network/access-clients.ts. Run with `npm test`
//  (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    AccessClientConfigurationError,
    createAccessApplier,
    createAccessObserver,
    createAccessTrunkApplier,
} from "../src/network/access-clients";

function environment(
    prefix: string,
    overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
    return {
        [`${prefix}_HOST`]: "exit",
        [`${prefix}_PORT`]: "2222",
        [`${prefix}_HOST_KEY_ALIAS`]: "172.16.0.34",
        [`${prefix}_USER`]: "root",
        [`${prefix}_IDENTITY_FILE`]: "/run/access/id_ed25519",
        [`${prefix}_KNOWN_HOSTS_FILE`]: "/run/access/known_hosts",
        ...overrides,
    } as NodeJS.ProcessEnv;
}

test("a fully configured observer, applier and trunk applier are constructed", () => {
    assert.ok(createAccessObserver(environment("ACCESS_OBSERVER")));
    assert.ok(createAccessApplier(environment("ACCESS_APPLIER")));
    assert.ok(createAccessTrunkApplier(environment("ACCESS_TRUNK_APPLIER")));
});

test("an unconfigured observer throws rather than looking like a clean observation", () => {
    // Access observation is what every Access apply proves itself against. A
    // stack that cannot observe must not resemble one that observed nothing
    // wrong.
    assert.throws(
        () => createAccessObserver({} as NodeJS.ProcessEnv),
        AccessClientConfigurationError,
    );
});

test("an unconfigured applier throws instead of silently doing nothing", () => {
    assert.throws(
        () => createAccessApplier({} as NodeJS.ProcessEnv),
        AccessClientConfigurationError,
    );
    assert.throws(
        () => createAccessTrunkApplier({} as NodeJS.ProcessEnv),
        AccessClientConfigurationError,
    );
});

test("the error names the missing variables so a stack can be fixed without guessing", () => {
    assert.throws(
        () => createAccessApplier(environment("ACCESS_APPLIER", {
            ACCESS_APPLIER_USER: undefined,
            ACCESS_APPLIER_IDENTITY_FILE: undefined,
        })),
        (error: AccessClientConfigurationError) => (
            error.missing.includes("ACCESS_APPLIER_USER")
            && error.missing.includes("ACCESS_APPLIER_IDENTITY_FILE")
        ),
    );
});

test("a relative identity path is rejected on every channel", () => {
    // It would resolve against whatever the process working directory happens
    // to be, which is not something an SSH identity should depend on.
    for (const [prefix, create] of [
        ["ACCESS_OBSERVER", createAccessObserver],
        ["ACCESS_APPLIER", createAccessApplier],
        ["ACCESS_TRUNK_APPLIER", createAccessTrunkApplier],
    ] as const) {
        assert.throws(
            () => create(environment(prefix, { [`${prefix}_IDENTITY_FILE`]: "id_ed25519" })),
            AccessClientConfigurationError,
        );
    }
});

test("the trunk applier is a separate principal from the policy applier", () => {
    // They mutate different things — the hypervisor's NIC versus the guest's
    // files — so one being configured must never imply the other.
    assert.ok(createAccessApplier(environment("ACCESS_APPLIER")));
    assert.throws(
        () => createAccessTrunkApplier(environment("ACCESS_APPLIER")),
        AccessClientConfigurationError,
    );
});

test("the port defaults to 22 rather than failing an otherwise complete channel", () => {
    assert.ok(createAccessObserver(environment("ACCESS_OBSERVER", {
        ACCESS_OBSERVER_PORT: undefined,
    })));
});
