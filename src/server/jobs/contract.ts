import { z } from "zod";

export const jobNameSchema = z.enum(["scheduled", "maintenance", "backup"]);
