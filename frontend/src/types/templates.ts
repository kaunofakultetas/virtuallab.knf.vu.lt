export interface Template {
    id: string | number;
    name?: string;
    type?: string;
    proxmox_id?: string | number;
    description?: string;
    visible_to_students?: boolean;
}
