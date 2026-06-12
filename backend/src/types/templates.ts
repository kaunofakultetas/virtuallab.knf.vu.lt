export type TemplateType = "student_vm" | "lab_vm";

export type ConnectionType = "guacamole" | "ssh" | "web";

export type SshConnectionConfig = {
    port?: number;
    username?: string;
    password?: string;
};

export type GuacamoleConnectionConfig = {
    username?: string;
    password?: string;
};

export type WebConnectionConfig = {
    port?: number;
    protocol?: "http" | "https";
};

export type ConnectionConfig =
    | SshConnectionConfig
    | GuacamoleConnectionConfig
    | WebConnectionConfig
    | Record<string, never>;

export type CreateTemplateDTO = {
    type: TemplateType;
    name: string;
    description?: string;
    proxmox_id: string;
    connection_type?: ConnectionType;
    connection_config?: ConnectionConfig;
};

export type UpdateTemplateDTO = {
    type?: TemplateType;
    name?: string;
    description?: string;
    proxmox_id?: string;
    visible_to_students?: boolean;
    connection_type?: ConnectionType;
    connection_config?: ConnectionConfig;
};

export type Template = {
    id: number;
    type: TemplateType;
    name: string;
    description?: string;

    proxmox_id: string;
    visible_to_students: boolean;

    connection_type: ConnectionType;
    connection_config: ConnectionConfig;

    created_at: Date;
    updated_at: Date;
};
