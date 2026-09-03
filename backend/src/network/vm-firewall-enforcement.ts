// -----------------------------------------------------------
//  [*] Network — is the datacenter firewall actually on?
//
//  Per-VM rules are inert unless the cluster firewall is
//  enabled — and nothing else would say so: every `.fw`
//  file reads correct, every apply converges, and student
//  VMs can simply reach each other. This check exists so a
//  silent, total loss of same-segment isolation surfaces in
//  the readiness report instead.
//
//  Used by:
//    - readiness.ts — the vm-firewall-enforcement check
// -----------------------------------------------------------

import { ProxmoxFirewallOptions, ProxmoxFirewallRule } from "@/proxmox/types";
import { ObservationStatus } from "./observations";

// The host ports the orchestrator itself reaches through the `exit` forwarder:
// the Proxmox API, and SSH for every restricted forced-command principal.
//
// These need explicit node rules. Proxmox's automatic management allowances are
// scoped to the host's own management network, and the orchestrator reaches the
// host from the isolated Docker network instead — so with the datacenter
// firewall on and no rule here, the control plane is cut off while every guest
// stays perfectly reachable, which is a confusing way to lose an orchestrator.
export const CONTROL_PLANE_PORTS = ["8006", "22"] as const;

export type VmFirewallEnforcementClient = {
    getClusterFirewallOptions(): Promise<ProxmoxFirewallOptions>;
    getNodeFirewallRules(): Promise<ProxmoxFirewallRule[]>;
};








// -----------------------------------------------------------
// checkVmFirewallEnforcement
// -----------------------------------------------------------
//
// Reports whether per-VM firewall policy is actually being
// enforced: the cluster enable flag, plus the node rules
// that keep the orchestrator's own control-plane ports open.
// The control-plane grading is there because enabling the
// firewall without those rules is what actually happened in
// testing: the orchestrator lost the Proxmox API and every
// restricted SSH channel at once.
//
// Used by:
//   - readiness.ts
// -----------------------------------------------------------

export async function checkVmFirewallEnforcement(
    client: VmFirewallEnforcementClient,
): Promise<{ status: ObservationStatus; detail: string }> {
    let options: ProxmoxFirewallOptions;
    let rules: ProxmoxFirewallRule[];
    try {
        [options, rules] = await Promise.all([
            client.getClusterFirewallOptions(),
            client.getNodeFirewallRules(),
        ]);
    } catch (error) {
        return {
            status: "fail",
            detail: `Proxmox firewall state could not be read: ${
                error instanceof Error ? error.message : "unknown failure"
            }`,
        };
    }

    if (options.enable !== 1) {
        return {
            status: "fail",
            detail: "The datacenter firewall is disabled, so every per-VM rule is inert "
                + "and student VMs on one VLAN can reach each other freely",
        };
    }

    const allowed = new Set(
        rules
            .filter((rule) => (
                rule.type === "in"
                && rule.action === "ACCEPT"
                && rule.enable !== 0
                && rule.proto === "tcp"
            ))
            .flatMap((rule) => (rule.dport ?? "").split(",").map((port) => port.trim())),
    );
    const missing = CONTROL_PLANE_PORTS.filter((port) => !allowed.has(port));
    if (missing.length > 0) {
        return {
            status: "fail",
            detail: `The datacenter firewall is enabled but no node rule admits the `
                + `orchestrator on tcp/${missing.join(", tcp/")}; the control plane will `
                + "lose the Proxmox API or its restricted SSH channels",
        };
    }

    return {
        status: "pass",
        detail: "The datacenter firewall is enforcing per-VM policy, and node rules admit "
            + `the orchestrator on tcp/${CONTROL_PLANE_PORTS.join(", tcp/")}`,
    };
}
