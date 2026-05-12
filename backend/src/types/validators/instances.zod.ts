import z from "zod";

export const createInstanceSchema = z.object({
  template_id: z.number().min(0, "template_id is required"),
});
