// -----------------------------------------------------------
//  [*] Network — the two-phase Access trunk apply
//
//  Observe → apply → prove → commit against the Proxmox
//  host's trunk executor
//  (infra/access/apply_access_trunk_forced_command.py). The
//  host arms a rollback timer before touching anything, so
//  every failure path is safe to abandon; the pre-commit
//  proof runs through the read-only Access observer, which
//  happens to report both halves of the trunk — exactly
//  what has to be proven.
//
//  Split into (executor last):
//
//    ACCESS_TRUNK_ROLLBACK_SECONDS      — default window
//    AccessTrunkApplyError              — staged failures
//    response schemas                   — the host's answers
//    RestrictedSshAccessTrunkApplyClient — the SSH channel
//    accessTrunkDrift                   — the proof check
//    applyAccessTrunk                   — the flow itself
//    abandon                            — best-effort rollback
//
//  Used by:
//    - access-trunk-runner.ts — the audited entry point
//    - access-clients.ts — constructs the SSH client
//    - test/access-trunk-apply.test.ts
// -----------------------------------------------------------

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AccessTrunkPlan } from "./access-trunk";
import { AccessHostObservation, AccessObservationClient } from "./adapters/access";
import { RestrictedSshTransport } from "./adapters/restricted-ssh";

// Default window between applying and committing a trunk change. Long enough
// for an independent observation over a fresh connection, short enough that a
// severed transport restores itself in minutes. The host clamps this to its own
// bounds.
export const ACCESS_TRUNK_ROLLBACK_SECONDS = 300;

export class AccessTrunkApplyError extends Error {
    // Whether the immediate rollback succeeded; undefined if none was attempted.
    rolledBack?: boolean;

    constructor(
        message: string,
        readonly stage: "observe" | "apply" | "verify" | "commit",
        readonly transactionId?: string,
    ) {
        super(message);
        this.name = "AccessTrunkApplyError";
    }
}

// Floored at 2 for the same reason `access-trunk.ts` floors its planner there:
// VLAN 1 is the untagged PVID membership, never a lab VLAN, and the host
// executor filters it out of every observation it returns. Seeing it here would
// mean the filter has gone, and a loud parse failure is the correct answer.
const vlanSchema = z.number().int().min(2).max(4094);

const observationShape = {
    // The raw `net1:` line. Carried so an apply can pass it back as an
    // optimistic-concurrency precondition rather than re-deriving a value the
    // host would have to trust.
    net1: z.string().min(1),
    persistent_vlan_ids: z.array(vlanSchema),
    live_veth_present: z.boolean(),
    live_vlan_ids: z.array(vlanSchema),
};

const envelopeShape = {
    version: z.literal(1),
    request_id: z.uuid(),
    target: z.literal("access-trunk"),
    captured_at: z.iso.datetime(),
};

export const accessTrunkObserveResponseSchema = z.object({
    ...envelopeShape,
    ...observationShape,
    operation: z.literal("observe"),
});

export const accessTrunkApplyResponseSchema = z.object({
    ...envelopeShape,
    operation: z.literal("apply"),
    transaction_id: z.string().min(1),
    desired_vlan_ids: z.array(vlanSchema),
    persistent_changed: z.boolean(),
    added: z.array(vlanSchema),
    removed: z.array(vlanSchema),
    observed: z.object(observationShape),
    converged: z.boolean(),
    rollback_armed: z.boolean(),
    rollback_seconds: z.number().int(),
});

export const accessTrunkCommitResponseSchema = z.object({
    ...envelopeShape,
    operation: z.literal("commit"),
    transaction_id: z.string().min(1),
    committed: z.literal(true),
    rollback_armed: z.boolean(),
    observed: z.object(observationShape),
});

export type AccessTrunkObserveResponse = z.infer<typeof accessTrunkObserveResponseSchema>;
export type AccessTrunkApplyResponse = z.infer<typeof accessTrunkApplyResponseSchema>;
export type AccessTrunkCommitResponse = z.infer<typeof accessTrunkCommitResponseSchema>;

export interface AccessTrunkApplyClient {
    observe(): Promise<AccessTrunkObserveResponse>;
    apply(input: {
        desiredVlanIds: number[];
        expectedNet1: string;
        rollbackSeconds: number;
    }): Promise<AccessTrunkApplyResponse>;
    commit(transactionId: string): Promise<AccessTrunkCommitResponse>;
    rollback(transactionId: string): Promise<unknown>;
}








// -----------------------------------------------------------
// RestrictedSshAccessTrunkApplyClient
// -----------------------------------------------------------
//
// AccessTrunkApplyClient over the restricted-SSH transport.
// Every answer is matched to the request that asked for it,
// the same rule the Access observation and apply clients
// follow — without it a stale answer left in the channel
// could be read as this transaction's result.
//
// Used by:
//   - access-clients.ts — createAccessTrunkApplier
// -----------------------------------------------------------

export class RestrictedSshAccessTrunkApplyClient implements AccessTrunkApplyClient {
    constructor(private readonly transport: Pick<RestrictedSshTransport, "execute">) {}

    async observe(): Promise<AccessTrunkObserveResponse> {
        return this.execute(accessTrunkObserveResponseSchema, (requestId) => ({
            version: 1,
            request_id: requestId,
            target: "access-trunk",
            operation: "observe",
        }));
    }

    async apply(input: {
        desiredVlanIds: number[];
        expectedNet1: string;
        rollbackSeconds: number;
    }): Promise<AccessTrunkApplyResponse> {
        return this.execute(accessTrunkApplyResponseSchema, (requestId) => ({
            version: 1,
            request_id: requestId,
            target: "access-trunk",
            operation: "apply",
            desired_vlan_ids: input.desiredVlanIds,
            expected_net1: input.expectedNet1,
            rollback_seconds: input.rollbackSeconds,
        }));
    }

    async commit(transactionId: string): Promise<AccessTrunkCommitResponse> {
        return this.execute(accessTrunkCommitResponseSchema, (requestId) => ({
            version: 1,
            request_id: requestId,
            target: "access-trunk",
            operation: "commit",
            transaction_id: transactionId,
        }));
    }

    async rollback(transactionId: string): Promise<unknown> {
        return this.transport.execute({
            version: 1,
            request_id: randomUUID(),
            target: "access-trunk",
            operation: "rollback",
            transaction_id: transactionId,
        });
    }

    private async execute<Output extends { request_id: string }>(
        schema: z.ZodType<Output>,
        request: (requestId: string) => Record<string, unknown>,
    ): Promise<Output> {
        const requestId = randomUUID();
        const result = schema.parse(await this.transport.execute(request(requestId)));
        if (result.request_id !== requestId) {
            throw new Error("Access trunk applier request ID does not match the request");
        }
        return result;
    }
}


export type AccessTrunkApplyDependencies = {
    apply: AccessTrunkApplyClient;
    // Used for the pre-commit proof. Deliberately a different client from
    // `apply`: it reaches the host through the read-only Access observer
    // principal, so a commit is never authorised by the session that made the
    // change. It also happens to report both halves of the trunk — the
    // container's persistent `trunks=` and the running veth's membership — which
    // is exactly what has to be proven.
    observe: AccessObservationClient;
    rollbackSeconds?: number;
};

export type AccessTrunkApplyResult = {
    // False when desired state already held, in which case nothing was staged.
    changed: boolean;
    transaction_id: string | null;
    desired_vlan_ids: number[];
    persistent_changed: boolean;
    added: number[];
    removed: number[];
};


function canonical(vlanIds: number[]): number[] {
    return [...new Set(vlanIds)].sort((left, right) => left - right);
}


function sameVlans(left: number[], right: number[]): boolean {
    const a = canonical(left);
    const b = canonical(right);
    return a.length === b.length && a.every((vlan, index) => vlan === b[index]);
}








// -----------------------------------------------------------
// accessTrunkDrift
// -----------------------------------------------------------
//
// Compares an independent Access observation against the
// desired trunk.
//
// Both halves are checked, because either can hold while
// the other drifts: `pct set` writes only the persistent
// allowlist and `bridge vlan` only the running veth. A
// trunk that is persistent-correct but live-stale passes no
// traffic today; one that is live-correct but
// persistent-stale stops passing traffic at the next
// restart.
//
// Used by:
//   - applyAccessTrunk (below) — the pre-commit proof
// -----------------------------------------------------------

export function accessTrunkDrift(
    desiredVlanIds: number[],
    observation: AccessHostObservation,
): string[] {
    const drift: string[] = [];
    if (!sameVlans(observation.net1.trunks, desiredVlanIds)) {
        drift.push(
            `persistent trunks [${observation.net1.trunks.join(", ")}] `
            + `do not match [${desiredVlanIds.join(", ")}]`,
        );
    }
    if (!observation.host_veth.exists) {
        drift.push(`${observation.host_veth.name} is absent`);
    } else if (!sameVlans(observation.host_veth.vlan_ids, desiredVlanIds)) {
        drift.push(
            `live membership [${observation.host_veth.vlan_ids.join(", ")}] `
            + `does not match [${desiredVlanIds.join(", ")}]`,
        );
    }
    return drift;
}








// -----------------------------------------------------------
// applyAccessTrunk
// -----------------------------------------------------------
//
// Reconciles the Access LXC's VLAN trunk and commits only
// once an independent observation agrees that both halves
// converged.
//
// The host arms a rollback timer before touching anything,
// so every failure path below is safe to abandon: not
// committing is itself the recovery. An explicit rollback
// is still attempted because it recovers in seconds rather
// than minutes, but it is best-effort — the timer remains
// the guarantee, and the host cancels it only after the
// restore succeeds.
//
// Used by:
//   - access-trunk-runner.ts
// -----------------------------------------------------------

export async function applyAccessTrunk(
    plan: AccessTrunkPlan,
    dependencies: AccessTrunkApplyDependencies,
): Promise<AccessTrunkApplyResult> {
    if (plan.live.status === "unobservable") {
        // The executor refuses this too. Reported here as well so a caller gets
        // a reason rather than a remote error, and so no rollback timer is armed
        // for a change that cannot be verified.
        throw new AccessTrunkApplyError(
            "Access host veth is absent; refusing to reconcile trunk membership blind",
            "observe",
        );
    }
    if (plan.no_change_required) {
        return {
            changed: false,
            transaction_id: null,
            desired_vlan_ids: plan.desired_vlan_ids,
            persistent_changed: false,
            added: [],
            removed: [],
        };
    }

    // Read the exact `net1:` line through the mutating channel so it can be
    // handed back as a precondition. This is optimistic concurrency on the same
    // connection, not a substitute for the cross-channel proof below.
    const before = await dependencies.apply.observe();

    const applied = await dependencies.apply.apply({
        desiredVlanIds: plan.desired_vlan_ids,
        expectedNet1: before.net1,
        rollbackSeconds: dependencies.rollbackSeconds ?? ACCESS_TRUNK_ROLLBACK_SECONDS,
    });

    if (!sameVlans(applied.desired_vlan_ids, plan.desired_vlan_ids)) {
        throw await abandon(
            dependencies,
            applied.transaction_id,
            new AccessTrunkApplyError(
                `Access trunk applied [${applied.desired_vlan_ids.join(", ")}], `
                + `expected [${plan.desired_vlan_ids.join(", ")}]`,
                "apply",
                applied.transaction_id,
            ),
        );
    }

    if (!applied.converged) {
        throw await abandon(
            dependencies,
            applied.transaction_id,
            new AccessTrunkApplyError(
                "Access trunk did not converge after applying: persistent "
                + `[${applied.observed.persistent_vlan_ids.join(", ")}], `
                + `live [${applied.observed.live_vlan_ids.join(", ")}]`,
                "apply",
                applied.transaction_id,
            ),
        );
    }

    if (!applied.rollback_armed) {
        // Without the timer there is no recovery if the next step cannot reach
        // the host, so refuse to proceed rather than rely on this session.
        throw await abandon(
            dependencies,
            applied.transaction_id,
            new AccessTrunkApplyError(
                "Access trunk applied without an armed rollback timer",
                "apply",
                applied.transaction_id,
            ),
        );
    }

    let drift: string[];
    try {
        drift = accessTrunkDrift(plan.desired_vlan_ids, await dependencies.observe.observe());
    } catch (error) {
        throw await abandon(
            dependencies,
            applied.transaction_id,
            new AccessTrunkApplyError(
                `Access could not be observed after the trunk change: ${
                    error instanceof Error ? error.message : "unknown failure"
                }`,
                "verify",
                applied.transaction_id,
            ),
        );
    }

    if (drift.length > 0) {
        throw await abandon(
            dependencies,
            applied.transaction_id,
            new AccessTrunkApplyError(
                `Access observation still reports trunk drift: ${drift.join("; ")}`,
                "verify",
                applied.transaction_id,
            ),
        );
    }

    const committed = await dependencies.apply.commit(applied.transaction_id);
    if (committed.rollback_armed) {
        // Not abandoned: the change is correct and proven. But an armed timer
        // means it will be undone minutes from now, so the caller must not
        // record this as a settled apply.
        throw new AccessTrunkApplyError(
            "Access trunk committed but the rollback timer is still armed",
            "commit",
            applied.transaction_id,
        );
    }

    return {
        changed: true,
        transaction_id: applied.transaction_id,
        desired_vlan_ids: applied.desired_vlan_ids,
        persistent_changed: applied.persistent_changed,
        added: applied.added,
        removed: applied.removed,
    };
}








// -----------------------------------------------------------
// abandon
// -----------------------------------------------------------
//
// Best-effort immediate rollback. A failure here is
// recorded on the error rather than replacing it: the
// original cause is what an operator needs, and the host's
// timer still restores the previous state either way.
//
// Used by:
//   - applyAccessTrunk (above) — every failure path
// -----------------------------------------------------------

async function abandon(
    dependencies: AccessTrunkApplyDependencies,
    transactionId: string,
    error: AccessTrunkApplyError,
): Promise<AccessTrunkApplyError> {
    try {
        await dependencies.apply.rollback(transactionId);
        error.rolledBack = true;
    } catch {
        error.rolledBack = false;
    }
    return error;
}
