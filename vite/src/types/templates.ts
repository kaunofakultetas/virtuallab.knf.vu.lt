// -----------------------------------------------------------
//  [*] Types — templates (API shapes)
//
//  Nearly every field optional, because the admin pages
//  build partial templates while editing; utils/templates.ts
//  normalises what the API returns into this shape.
//
//  Used by:
//    - utils/templates.ts, pages/admin/Templates.tsx,
//      TemplateDetails.tsx, TemplateFormDialog.tsx
// -----------------------------------------------------------

export type ConnectionType = "guacamole" | "ssh" | "web";

export interface Template {
    id: string | number;
    name?: string;
    type?: string;
    proxmox_id?: string | number;
    description?: string;
    visible_to_students?: boolean;
    connection_type?: ConnectionType;
    connection_config?: {
        port?: number;
        protocol?: "http" | "https";
        username?: string;
        password?: string;
    };
}
