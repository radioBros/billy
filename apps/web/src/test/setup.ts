/**
 * Vitest setup (jsdom). Provides a default runtime config so getConfig() has a
 * base URL; individual tests may override window.__APP_CONFIG__.
 */
import { beforeEach } from "vitest";

beforeEach(() => {
  window.__APP_CONFIG__ = {
    APP_URL: "http://localhost",
    API_URL: "http://api.test/api",
    VAPID_PUBLIC_KEY: "",
  };
});
