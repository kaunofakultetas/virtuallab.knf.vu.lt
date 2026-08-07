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
    component: "proxmox-vnet" | "access" | "gateway";
    operation: "create" | "update";
    resource: string;
    desired: unknown;
};

export type ReconciliationDryRun = {
    checks: ReconciliationCheck[];
    actions: ReconciliationAction[];
};