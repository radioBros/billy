/**
 * Public-links module barrel.
 *
 * INTEGRATOR: `createPublicLinksRouter` mounts on the SEPARATE PUBLIC PLANE —
 * mount it directly in app.ts (NOT via mountDomainModules / registry.ts, which is
 * the authed /api/v1 plane), before the session-only routes. See routes.ts.
 */
export { createPublicLinksRouter } from "@/modules/public-links/routes.js";
export { PublicLinkService, type PublicLinkServiceDeps } from "@/modules/public-links/service.js";
export { serializePublicQuote, serializePublicInvoice } from "@/modules/public-links/serializer.js";
export { createInMemoryRateLimiter, DEFAULT_PUBLIC_RATE_LIMIT, type InMemoryRateLimiterOptions } from "@/modules/public-links/rate-limit.js";
export type {
  PublicQuoteDTO,
  PublicInvoiceDTO,
  PublicLineItemDTO,
  PublicIssuerDTO,
  PublicQuoteDoc,
  PublicInvoiceDoc,
  RateLimiter,
} from "@/modules/public-links/types.js";
