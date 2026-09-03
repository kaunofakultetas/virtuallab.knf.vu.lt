// -----------------------------------------------------------
//  [*] Network — the reconciliation attempt log and lock
//
//  Two things every apply shares: the persisted attempt
//  record (network_reconciliation_attempts — the audit
//  trail of checks, actions, phases and outcomes) and the
//  advisory lock that keeps VNet, Access, trunk and Gateway
//  applies from ever running concurrently.
//
//  Used by:
//    - every apply runner and the drift reconciler
//    - network.route.ts — reading attempts back
// -----------------------------------------------------------

import { randomUUID } from "node:crypto";
import { QueryResult, QueryResultRow } from "pg";
import { pool } from "@/utils/db";
import type { ReconciliationAction, ReconciliationCheck } from "./reconciliation-types";

// Arbitrary but fixed: every process that takes the reconciliation lock must
// agree on this number.
export const NETWORK_RECONCILIATION_ADVISORY_LOCK = 1447838019;

export type ReconciliationMode = "dry-run" | "apply";
export type ReconciliationAttemptStatus = "running" | "succeeded" | "failed" | "abandoned";
export type ReconciliationPhase =
    | "initializing"
    | "planning"
    | "planned"
    | "applying"
    | "verifying"
    | "applied"
    | "apply-failed"
    | "compensating"
    | "compensated"
    | "compensation-failed"
    | "observation-failed"
    | "abandoned";

export type ReconciliationAttempt = {
    id: string;
    request_id: string;
    requested_by: string;
    idempotency_key: string | null;
    mode: ReconciliationMode;
    status: ReconciliationAttemptStatus;
    desired_revision: string;
    applied_revision: string | null;
    phase: ReconciliationPhase;
    checks: ReconciliationCheck[];
    actions: ReconciliationAction[];
    error_code: string | null;
    error_detail: string | null;
    created_at: Date;
    started_at: Date;
    finished_at: Date | null;
};

export type CreateReconciliationAttempt = {
    requestedBy: string;
    mode: ReconciliationMode;
    desiredRevision: string;
    idempotencyKey?: string;
    requestId?: string;
};

export type FinishReconciliationAttempt = {
    status: Exclude<ReconciliationAttemptStatus, "running">;
    phase: ReconciliationPhase;
    checks: ReconciliationCheck[];
    actions: ReconciliationAction[];
    appliedRevision?: string;
    errorCode?: string;
    errorDetail?: string;
};

export type CheckpointReconciliationAttempt = {
    phase: ReconciliationPhase;
    checks?: ReconciliationCheck[];
    actions?: ReconciliationAction[];
};

export type ReconciliationQueryClient = {
    query<Row extends QueryResultRow = QueryResultRow>(
        queryText: string,
        values?: unknown[],
    ): Promise<QueryResult<Row>>;
};

export type ReconciliationLockClient = ReconciliationQueryClient & {
    release(): void;
};

export type ReconciliationPool = ReconciliationQueryClient & {
    connect(): Promise<ReconciliationLockClient>;
};

export class ReconciliationLockedError extends Error {
    constructor() {
        super("Network infrastructure reconciliation is already running");
        this.name = "ReconciliationLockedError";
    }
}








// -----------------------------------------------------------
// ReconciliationAttemptRepository
// -----------------------------------------------------------
//
// CRUD over the attempt table. checkpoint() and finish()
// only touch rows still `running`, so a finished attempt
// can never be rewritten; abandonRunning() sweeps up
// attempts a dead process left behind before a new one
// starts.
//
// Used by:
//   - every apply runner, infrastructure-reconciler.ts
//   - network.route.ts — getById
// -----------------------------------------------------------

export class ReconciliationAttemptRepository {
    constructor(private readonly database: ReconciliationQueryClient = pool) {}

    async create(input: CreateReconciliationAttempt): Promise<ReconciliationAttempt> {
        const result = await this.database.query<ReconciliationAttempt>(
            `INSERT INTO network_reconciliation_attempts (
                request_id,
                requested_by,
                idempotency_key,
                mode,
                desired_revision
             ) VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
                input.requestId ?? randomUUID(),
                input.requestedBy,
                input.idempotencyKey ?? null,
                input.mode,
                input.desiredRevision,
            ],
        );
        return result.rows[0];
    }

    async getById(id: string): Promise<ReconciliationAttempt | null> {
        const result = await this.database.query<ReconciliationAttempt>(
            "SELECT * FROM network_reconciliation_attempts WHERE id = $1",
            [id],
        );
        return result.rows[0] ?? null;
    }

    async abandonRunning(): Promise<number> {
        const result = await this.database.query(
            `UPDATE network_reconciliation_attempts
             SET status = 'abandoned',
                 phase = 'abandoned',
                 error_code = 'process-interrupted',
                 error_detail = 'The reconciliation process ended before recording a terminal result',
                 finished_at = NOW()
             WHERE status = 'running'`,
        );
        return result.rowCount ?? 0;
    }

    async checkpoint(
        id: string,
        input: CheckpointReconciliationAttempt,
    ): Promise<ReconciliationAttempt> {
        const result = await this.database.query<ReconciliationAttempt>(
            `UPDATE network_reconciliation_attempts
             SET phase = $2,
                 checks = COALESCE($3::jsonb, checks),
                 actions = COALESCE($4::jsonb, actions)
             WHERE id = $1 AND status = 'running'
             RETURNING *`,
            [
                id,
                input.phase,
                input.checks === undefined ? null : JSON.stringify(input.checks),
                input.actions === undefined ? null : JSON.stringify(input.actions),
            ],
        );
        if (!result.rows[0]) {
            throw new Error(`Running reconciliation attempt ${id} does not exist`);
        }
        return result.rows[0];
    }

    async finish(id: string, input: FinishReconciliationAttempt): Promise<ReconciliationAttempt> {
        const result = await this.database.query<ReconciliationAttempt>(
            `UPDATE network_reconciliation_attempts
             SET status = $2,
                 phase = $3,
                 checks = $4::jsonb,
                 actions = $5::jsonb,
                 applied_revision = $6,
                 error_code = $7,
                 error_detail = $8,
                 finished_at = NOW()
             WHERE id = $1 AND status = 'running'
             RETURNING *`,
            [
                id,
                input.status,
                input.phase,
                JSON.stringify(input.checks),
                JSON.stringify(input.actions),
                input.appliedRevision ?? null,
                input.errorCode ?? null,
                input.errorDetail ?? null,
            ],
        );
        if (!result.rows[0]) {
            throw new Error(`Running reconciliation attempt ${id} does not exist`);
        }
        return result.rows[0];
    }
}








// -----------------------------------------------------------
// withReconciliationLock
// -----------------------------------------------------------
//
// try-lock, not wait: a second reconciliation is refused
// with ReconciliationLockedError rather than queued, so
// callers surface "already running" instead of piling up.
// The lock lives on the dedicated client's session and is
// released before the client goes back to the pool.
//
// Used by:
//   - every apply runner
// -----------------------------------------------------------

export async function withReconciliationLock<T>(
    callback: (client: ReconciliationLockClient) => Promise<T>,
    database: Pick<ReconciliationPool, "connect"> = pool,
): Promise<T> {
    const client = await database.connect();
    let acquired = false;
    try {
        const result = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1) AS acquired",
            [NETWORK_RECONCILIATION_ADVISORY_LOCK],
        );
        acquired = result.rows[0]?.acquired === true;
        if (!acquired) {
            throw new ReconciliationLockedError();
        }
        return await callback(client);
    } finally {
        if (acquired) {
            await client.query("SELECT pg_advisory_unlock($1)", [
                NETWORK_RECONCILIATION_ADVISORY_LOCK,
            ]);
        }
        client.release();
    }
}
