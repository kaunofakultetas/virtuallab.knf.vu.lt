// -----------------------------------------------------------
//  [*] Types — lab profiles (API shapes)
//
//  Mirrors the backend's /lab-profiles responses; dates
//  arrive as ISO strings.
//
//  Used by:
//    - pages/admin/LabProfiles.tsx, pages/Instances.tsx,
//      pages/admin/AdminInstances.tsx
// -----------------------------------------------------------

import type { Template } from "@/types/templates";

export interface AllowedWebDomain {
    domain: string;
    include_subdomains: boolean;
}

export interface LabProfile {
    id: number;
    name: string;
    description: string | null;
    allow_same_group: boolean;
    is_default: boolean;
    domains: AllowedWebDomain[];
    templates: Template[];
    created_at: string;
    updated_at: string;
}
