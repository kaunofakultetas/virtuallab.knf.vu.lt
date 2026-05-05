export type TemplateType = "student_vm" | "lab_vm";

export type CreateTemplateDTO = {
  type: TemplateType;
  name: string;
  description?: string;
  proxmox_id: string;
};

export type UpdateTemplateDTO = {
  type?: TemplateType;
  name?: string;
  description?: string;
  proxmox_id?: string;
  visible_to_students?: boolean;
};

export type Template = {
  id: number;
  type: TemplateType;
  name: string;
  description?: string;

  proxmox_id: string; // The ID of the template in Proxmox
  visible_to_students: boolean;

  created_at: Date;
  updated_at: Date;
};
