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
