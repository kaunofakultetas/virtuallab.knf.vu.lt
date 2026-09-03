// -----------------------------------------------------------
//  [*] Network — reconciliation result types
//
//  The shared vocabulary of a reconciliation pass: checks
//  (what was observed, per component, pass/fail/unobserved)
//  and actions (what would be — or was — done about it,
//  with an execution state that survives into the persisted
//  attempt).
//
//  Used by:
//    - infrastructure-reconciler.ts, drift-reconciler.ts,
//      reconciliation-attempts.ts and the observation
//      modules that produce checks
// -----------------------------------------------------------

export type ReconciliationCheckStatus = "pass" | "fail" | "unobserved";

export type ReconciliationCheck = {
    key: string;
    component: "proxmox-vnet" | "firewall" | "access" | "gateway";
    status: ReconciliationCheckStatus;
    required: boolean;
    detail: string;
    observed?: unknown;
};

export type ReconciliationAction = {
    component: "proxmox-vnet" | "access" | "gateway" | "firewall";
    operation: "create" | "update";
    execution_state: "planned" | "applying" | "succeeded" | "failed" | "compensated";
    resource: string;
    desired: unknown;
};

export type ReconciliationDryRun = {
    checks: ReconciliationCheck[];
    actions: ReconciliationAction[];
};
