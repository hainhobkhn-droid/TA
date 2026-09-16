import { describe, it, expect, vi } from "vitest";
import { encrypt, decrypt } from "../src/server/channels/crypto.js";
import { effectiveMode } from "../src/server/channels/dispatch.js";
import { can } from "../src/shared/permissions.js";
import { readConfig } from "../src/server/config.js";
import { facebookConnection } from "../src/server/channels/facebook.js";

const c = readConfig({
  DATABASE_URL: "postgresql://unused",
  AUTH_SECRET: "fixture-only-auth-secret-not-for-live-usage",
  BOOTSTRAP_TOKEN: "fixture-only-bootstrap-not-for-live-usage",
  ENCRYPTION_KEY: "ab".repeat(32),
  META_APP_ID: "123",
  META_APP_SECRET: "fixture-app-secret",
  NODE_ENV: "test",
});
describe("credential envelope", () => {
  it("roundtrips without plaintext and uses fresh nonces", () => {
    const a = encrypt({ token: "sensitive-fixture" }, "business:one", c);
    const b = encrypt({ token: "sensitive-fixture" }, "business:one", c);
    expect(JSON.stringify(a)).not.toContain("sensitive-fixture");
    expect(a.data.nonce).not.toBe(b.data.nonce);
    expect(decrypt(a, "business:one", c)).toEqual({
      token: "sensitive-fixture",
    });
  });
  it("rejects tampering, wrong tenant, wrong wrapping key and unknown key IDs", () => {
    const value = encrypt({ token: "secret" }, "business:one", c);
    expect(() => decrypt(value, "business:two", c)).toThrow();
    expect(() =>
      decrypt(value, "business:one", { ...c, ENCRYPTION_KEY: "cd".repeat(32) }),
    ).toThrow();
    expect(() =>
      decrypt({ ...value, keyId: "v2" }, "business:one", c),
    ).toThrow();
    const tampered = structuredClone(value);
    tampered.data.ciphertext = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(tampered, "business:one", c)).toThrow();
  });
});
it("global dry-run cannot be overridden by channel mode", () => {
  for (const mode of ["live", "manual", "dry_run"] as const)
    expect(effectiveMode("dry_run", mode)).toBe("dry_run");
  expect(effectiveMode("live", "manual")).toBe("manual");
});
it("denies write escalation and channel scope bypass", () => {
  expect(can("viewer", ["facebook"], "channels.connect", "facebook")).toBe(
    false,
  );
  expect(can("agent", ["facebook"], "posts.write", "facebook")).toBe(false);
  expect(can("agent", ["facebook"], "replies.write", "facebook")).toBe(true);
  expect(can("agent", ["facebook"], "replies.write", "tiktok")).toBe(false);
  expect(can("owner", [], "channels.connect", "facebook")).toBe(false);
});
it("rejects invalid mode, unsafe production origin and malformed encryption keys", () => {
  expect(() => readConfig({ ...c, HELPA_MODE: "unknown" })).toThrow();
  expect(() =>
    readConfig({
      ...c,
      NODE_ENV: "production",
      PUBLIC_URL: "http://example.org",
    }),
  ).toThrow();
  expect(() => readConfig({ ...c, ENCRYPTION_KEY: "short" })).toThrow();
  expect(() =>
    readConfig({ ...c, PUBLIC_URL: "https://example.org/path" }),
  ).toThrow();
});
describe("Facebook OAuth contract (synthetic fixtures based on official docs)", () => {
  it("uses code exchange, long-lived exchange, inspection and Page discovery; no publishing calls", async () => {
    const results = [
      { access_token: "short" },
      { access_token: "long" },
      {
        data: {
          is_valid: true,
          app_id: "123",
          scopes: ["pages_show_list"],
          expires_at: 0,
        },
      },
      {
        data: [
          {
            id: "456",
            name: "Fixture Page",
            access_token: "page-secret",
            tasks: ["CREATE_CONTENT"],
          },
        ],
      },
      {
        data: {
          is_valid: true,
          app_id: "123",
          scopes: ["pages_show_list"],
          expires_at: 0,
        },
      },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify(results.shift()), { status: 200 }),
      );
    const fb = facebookConnection(c, fetcher);
    const url = new URL(fb.authorizationUrl("one-time-state"));
    expect(url.searchParams.get("state")).toBe("one-time-state");
    expect(url.searchParams.get("scope")).toBe(
      "pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,pages_messaging,pages_manage_metadata",
    );
    const pages = await fb.discover("code");
    expect(pages[0]).toMatchObject({
      id: "456",
      accessToken: "page-secret",
      expiryKind: "no_scheduled_expiry",
      expiresAt: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      "/v25.0/oauth/access_token",
      "/v25.0/oauth/access_token",
      "/v25.0/debug_token",
      "/v25.0/me/accounts",
      "/v25.0/debug_token",
    ]);
    expect(
      new URL(String(fetcher.mock.calls[1][0])).searchParams.get("grant_type"),
    ).toBe("fb_exchange_token");
  });
  it("rejects a token from a different app", async () => {
    const values = [
      { access_token: "short" },
      { access_token: "long" },
      {
        data: { is_valid: true, app_id: "other", scopes: ["pages_show_list"] },
      },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify(values.shift())),
      );
    await expect(
      facebookConnection(c, fetcher).discover("code"),
    ).rejects.toThrow("META_TOKEN_INVALID");
  });
  it("never exposes upstream tokens or error descriptions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 190, message: "token-secret in request" },
        }),
        { status: 400 },
      ),
    );
    await expect(
      facebookConnection(c, fetcher).discover("code"),
    ).rejects.toThrow("META_RECONNECT_REQUIRED");
  });
});
