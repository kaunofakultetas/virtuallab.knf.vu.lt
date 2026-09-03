// -----------------------------------------------------------
//  [*] Types — lab profiles
//
//  A lab profile bundles what a student's lab is allowed to
//  reach: web domains (for the Gateway's Squid allowlist),
//  whether same-group VMs may talk to each other, and which
//  templates the profile offers.
//
//  Used by:
//    - lab-profiles.controller.ts, lab-profiles.route.ts
//      (network/policy.ts reads the same data straight from
//      the DB rather than through these types)
// -----------------------------------------------------------

import { Template } from "@/types/templates";

export type AllowedWebDomain = {
    domain: string;
    include_subdomains: boolean;
};

export type LabProfile = {
    id: number;
    name: string;
    description: string | null;
    allow_same_group: boolean;
    is_default: boolean;
    domains: AllowedWebDomain[];
    templates: Template[];
    created_at: Date;
    updated_at: Date;
};

export type CreateLabProfileDTO = {
    name: string;
    description?: string;
    allow_same_group?: boolean;
    domains?: AllowedWebDomain[];
    template_ids?: number[];
};

export type UpdateLabProfileDTO = Partial<CreateLabProfileDTO>;
