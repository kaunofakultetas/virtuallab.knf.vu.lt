// -----------------------------------------------------------
//  [*] Tests — the policy tables
//
//  Strict domain validation and undirected peering ordering.
//
//  Covers src/network/policy.ts. Run with `npm test` (the
//  whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    allowedDomainSchema,
    domainSchema,
    NetworkPolicyError,
    orderPeering,
} from "../src/network/policy";

test("a plain hostname is accepted and normalised", () => {
    assert.equal(domainSchema.parse("Archive.Ubuntu.COM"), "archive.ubuntu.com");
    assert.equal(domainSchema.parse("  example.com  "), "example.com");
});

test("anything that is not a bare hostname is refused", () => {
    // Squid is handed these as dstdomain and ssl::server_name values. A scheme,
    // port or path would either widen the allowlist or fail to parse on the
    // Gateway, after the apply, where it is expensive to discover.
    for (const invalid of [
        "https://example.com",
        "example.com/path",
        "example.com:443",
        "example .com",
        ".example.com",
        "example.com.",
        "*.example.com",
        "example",
        "",
        "-example.com",
        "example-.com",
    ]) {
        assert.equal(
            domainSchema.safeParse(invalid).success,
            false,
            `expected ${JSON.stringify(invalid)} to be refused`,
        );
    }
});

test("subdomain matching defaults on, because that is what an allowlist usually means", () => {
    assert.equal(allowedDomainSchema.parse({ domain: "example.com" }).include_subdomains, true);
    assert.equal(
        allowedDomainSchema.parse({ domain: "example.com", include_subdomains: false })
            .include_subdomains,
        false,
    );
});

test("unknown fields are refused rather than silently dropped", () => {
    assert.equal(
        allowedDomainSchema.safeParse({ domain: "example.com", allow_all: true }).success,
        false,
    );
});

test("a peering is stored in one canonical order whichever way it is given", () => {
    // (7, 4) and (4, 7) are the same relationship. Storing both would let a
    // deletion leave the other rendering rules for a peering the admin believed
    // they had removed.
    assert.deepEqual(orderPeering(7, 4), { group_a_id: 4, group_b_id: 7 });
    assert.deepEqual(orderPeering(4, 7), { group_a_id: 4, group_b_id: 7 });
});

test("a group cannot be peered with itself", () => {
    assert.throws(() => orderPeering(4, 4), NetworkPolicyError);
});

test("non-integer group IDs are refused", () => {
    assert.throws(() => orderPeering(4.5, 7), NetworkPolicyError);
});
