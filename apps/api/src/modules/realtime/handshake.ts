import type { AuthContext } from "@billy/types";
import { SESSION_COOKIE_NAME } from "@/modules/auth/session.js";

/**
 * WebSocket handshake authentication. A WS connection is authenticated IDENTICALLY to an
 * HTTP request: the same `billy_session` HttpOnly cookie, resolved by the same
 * auth session resolver — there is NO separate token scheme.
 *
 * This module is pure/injectable so the handshake logic can be unit-tested with
 * a mocked resolver, without opening a real socket.
 */

/**
 * The minimal slice of `AuthService` the handshake needs: cookie token →
 * AuthContext (exactly what `sessionMiddleware`/`requireAuth` rely on). Kept as
 * a narrow interface so tests inject a mock and production passes the real
 * `AuthService` (its `resolve` matches this shape).
 */
export interface SessionResolver {
  resolve(token: string | undefined): Promise<{ authContext: AuthContext } | null>;
}

export const extractSessionToken = (cookieHeader: string | undefined): string | undefined => {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const rawValue = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      // malformed percent-encoding — treat as the raw value rather than throw.
      return rawValue;
    }
  }
  return undefined;
};

export const authenticateHandshake = async (cookieHeader: string | undefined, resolver: SessionResolver): Promise<AuthContext | null> => {
  const token = extractSessionToken(cookieHeader);
  if (!token) return null;
  const resolved = await resolver.resolve(token);
  return resolved ? resolved.authContext : null;
};
