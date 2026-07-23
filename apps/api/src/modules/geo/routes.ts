import Router from "@koa/router";
import type { Logger } from "@billy/shared";
import { requireAuth } from "@/modules/auth/middleware.js";
import type { AppState } from "@/app.js";
import { respondOk } from "@/platform/serializer.js";

/**
 * `/api/v1/geo/*` — server-side proxy to the Geoapify geocoding API for address
 * autocomplete. The API key lives ONLY here (GEOAPIFY_API_KEY, server env); the
 * web app never sees it. Returns a normalized suggestion list including the CIVIC
 * (house) number, which the address form fills into a dedicated field.
 *
 * When no key is configured the endpoint returns an empty list (feature simply
 * off) rather than erroring — the address fields stay manually editable.
 */

interface AddressSuggestion {
  label: string;
  line1: string; // "street houseNumber" (best-effort)
  street: string;
  houseNumber: string;
  city: string;
  region: string;
  postalCode: string;
  country: string; // ISO alpha-2, upper-case
}

interface GeoapifyProps {
  formatted?: string;
  address_line1?: string;
  street?: string;
  housenumber?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country_code?: string;
}

const normalize = (features: { properties?: GeoapifyProps }[]): AddressSuggestion[] =>
  features.map((f) => {
    const p = f.properties ?? {};
    const street = p.street ?? "";
    const houseNumber = p.housenumber ?? "";
    const line1 = p.address_line1 ?? [street, houseNumber].filter(Boolean).join(" ").trim();
    return {
      label: p.formatted ?? line1,
      line1,
      street,
      houseNumber,
      city: p.city ?? "",
      region: p.state ?? "",
      postalCode: p.postcode ?? "",
      country: (p.country_code ?? "").toUpperCase(),
    };
  });

export const createGeoRouter = (deps: { apiKey?: string; logger: Logger }): Router<AppState> => {
  const r = new Router<AppState>({ prefix: "/api/v1/geo" });

  // GET /api/v1/geo/autocomplete?q=... — proxied Geoapify address suggestions.
  r.get("/autocomplete", requireAuth, async (ctx) => {
    const q = String((ctx.query.q as string | undefined) ?? "").trim();
    if (!deps.apiKey || q.length < 3) {
      respondOk(ctx, { suggestions: [] as AddressSuggestion[], enabled: Boolean(deps.apiKey) });
      return;
    }
    try {
      const url = new URL("https://api.geoapify.com/v1/geocode/autocomplete");
      url.searchParams.set("text", q);
      url.searchParams.set("format", "geojson");
      url.searchParams.set("limit", "6");
      url.searchParams.set("apiKey", deps.apiKey);
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) {
        deps.logger.warn({ status: res.status }, "geoapify: upstream error");
        respondOk(ctx, { suggestions: [], enabled: true });
        return;
      }
      const body = (await res.json()) as { features?: { properties?: GeoapifyProps }[] };
      respondOk(ctx, { suggestions: normalize(body.features ?? []), enabled: true });
    } catch (err) {
      deps.logger.warn({ err }, "geoapify: proxy failed");
      respondOk(ctx, { suggestions: [], enabled: true });
    }
  });

  return r;
};
