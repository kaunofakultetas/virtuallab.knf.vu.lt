// -----------------------------------------------------------
//  [*] Tests — the attempt repository and lock
//
//  Attempt lifecycle guards (running-only updates) and the
//  try-lock semantics.
//
//  Covers src/network/reconciliation-attempts.ts. Run with
//  `npm test` (the whole suite) inside the backend
//  container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { QueryResult, QueryResultRow } from "pg";
import {
    NETWORK_RECONCILIATION_ADVISORY_LOCK,
    ReconciliationAttemptRepository,
    ReconciliationLockedError,
    withReconciliationLock,
} from "../src/network/reconciliation-attempts";

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
    return {
        command: "SELECT",
        rowCount: rows.length,
        oid: 0,
        fields: [],
        rows,
    };
}

test("holds and releases the reconciliation lock on the same client", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    let released = false;
    const client = {
        async query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
            calls.push({ sql, values });
            if (sql.includes("pg_try_advisory_lock")) {
                return result([{ acquired: true }] as unknown as Row[]);
            }
            return result([] as Row[]);
        },
        release() {
            released = true;
        },
    };

    const value = await withReconciliationLock(async (lockedClient) => {
        assert.equal(lockedClient, client);
        return "complete";
    }, { async connect() { return client; } });

    assert.equal(value, "complete");
    assert.deepEqual(calls.map(({ values }) => values), [
        [NETWORK_RECONCILIATION_ADVISORY_LOCK],
        [NETWORK_RECONCILIATION_ADVISORY_LOCK],
    ]);
    assert.match(calls[1].sql, /pg_advisory_unlock/);
    assert.equal(released, true);
});

test("rejects a held lock and still releases the client", async () => {
    let released = false;
    const client = {
        async query<Row extends QueryResultRow>() {
            return result([{ acquired: false }] as unknown as Row[]);
        },
        release() {
            released = true;
        },
    };

    await assert.rejects(
        withReconciliationLock(async () => "unreachable", {
            async connect() { return client; },
        }),
        ReconciliationLockedError,
    );
    assert.equal(released, true);
});

test("unlocks when reconciliation work fails", async () => {
    const calls: string[] = [];
    const client = {
        async query<Row extends QueryResultRow>(sql: string) {
            calls.push(sql);
            return result([{ acquired: true }] as unknown as Row[]);
        },
        release() {},
    };

    await assert.rejects(
        withReconciliationLock(async () => {
            throw new Error("apply failed");
        }, { async connect() { return client; } }),
        /apply failed/,
    );
    assert.match(calls[1], /pg_advisory_unlock/);
});

test("rejects checkpoints for attempts that are no longer running", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const repository = new ReconciliationAttemptRepository({
        async query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
            calls.push({ sql, values });
            return result([] as Row[]);
        },
    });

    await assert.rejects(
        repository.checkpoint("42", { phase: "planning" }),
        /Running reconciliation attempt 42 does not exist/,
    );
    assert.match(calls[0].sql, /WHERE id = \$1 AND status = 'running'/);
    assert.deepEqual(calls[0].values, ["42", "planning", null, null]);
});