export type ProxmoxStatus = "running" | "stopped" | "suspended";

export interface InstanceData {
  ip_address: string;
}

export interface Instance {
  id: number;
  owner_id: number;
  template_id: number;
  proxmox_id: string;

  name: string;
  status: ProxmoxStatus;
  data: InstanceData;

  created_at: Date;
  run_until: Date | null;
}

export type CreateInstanceDTO = {
  template_id: number;
};
