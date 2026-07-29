import { type AuthContext } from "@billy/types";
import { successEnvelope } from "@billy/shared";
import type { Context } from "koa";
import type { ListMeta } from "@billy/types";

export const canSeeFinancials = (ctx: AuthContext): boolean => {
  return ctx.role === "administrator" || ctx.capabilities.canViewFinancialTotals;
};

export const stripFinancial = <T extends object>(ctx: AuthContext, doc: T, financialFields: readonly string[]): T => {
  if (canSeeFinancials(ctx)) return doc;
  const copy = { ...doc } as Record<string, unknown>;
  for (const f of financialFields) delete copy[f];
  return copy as unknown as T;
};

export const stripFinancialList = <T extends object>(ctx: AuthContext, docs: readonly T[], financialFields: readonly string[]): T[] => {
  if (canSeeFinancials(ctx)) return [...docs];
  return docs.map((d) => stripFinancial(ctx, d, financialFields));
};

export const respondOk = (ctx: Context, data: unknown, meta: Record<string, unknown> = {}): void => {
  ctx.status = 200;
  ctx.body = successEnvelope(data, meta);
};

export const respondCreated = (ctx: Context, data: unknown): void => {
  ctx.status = 201;
  ctx.body = successEnvelope(data, {});
};

export const respondList = (ctx: Context, items: unknown[], meta: ListMeta): void => {
  ctx.status = 200;
  ctx.body = successEnvelope(items, meta as unknown as Record<string, unknown>);
};
