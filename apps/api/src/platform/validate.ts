import { z } from "zod";
import { safeValidate } from "@billy/validation";
import { errors } from "@billy/shared";

export const validate = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
  const result = safeValidate(schema, data);
  if (!result.ok) {
    throw errors.validation("Validation failed", result.details);
  }
  return result.value;
};
