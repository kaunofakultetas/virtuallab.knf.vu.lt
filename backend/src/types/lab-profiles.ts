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