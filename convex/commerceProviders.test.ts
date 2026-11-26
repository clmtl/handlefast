import { afterEach, describe, expect, test, vi } from "vitest";
import { normalizeOrder, normalizeTracking, shopifyGraphql } from "./lib/commerceProviders";
import { decrypt, encrypt, verifyShopify } from "./lib/commerceSecrets";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("commerce provider contracts", () => {
  test("normalizes refunds, partial fulfillment, null customer fields and explicitly marks truncated details", () => {
    const order = normalizeOrder({
      id: "gid://shopify/Order/1234",
      name: "#1234",
      email: null,
      createdAt: "2026-10-01T12:00:00Z",
      updatedAt: "2026-10-02T12:00:00Z",
      cancelledAt: null,
      displayFinancialStatus: "PARTIALLY_REFUNDED",
      displayFulfillmentStatus: "PARTIALLY_FULFILLED",
      currentTotalPriceSet: { shopMoney: { amount: "30", currencyCode: "EUR" } },
      totalRefundedSet: { shopMoney: { amount: "10", currencyCode: "EUR" } },
      shippingAddress: null,
      lineItems: {
        nodes: [{ id: "line1", title: "Shirt", quantity: 1, sku: null, variantTitle: null }],
        pageInfo: { hasNextPage: true },
      },
      fulfillments: [
        { id: "f1", status: "SUCCESS", trackingInfo: [{ number: "TRACK1", company: "Carrier" }] },
        {
          id: "f2",
          status: "CANCELLED",
          trackingInfo: [{ number: "CANCELLED1", company: "Carrier" }],
        },
      ],
    });
    expect(order.email).toBeUndefined();
    expect(order.refunded).toBe("10");
    expect(order.detailsTruncated).toBe(true);
    expect(order.tracking).toHaveLength(1);
    expect(order.tracking[0].number).toBe("TRACK1");
  });
  test("deduplicates tracking events, keeps only supplied timestamps, bounds history and never invents an ETA", () => {
    const event = {
      time_utc: "2026-10-02T12:00:00Z",
      description: "In transit",
      location: "Paris",
    };
    const update = normalizeTracking({
      number: "TRACK1",
      carrier: 3011,
      track_info: {
        latest_status: { status: "InTransit" },
        latest_event: event,
        tracking: {
          providers: [
            {
              latest_sync_time: "2026-10-03T12:00:00Z",
              events: [event, { time_iso: "2026-10-02T12:00:00", description: "Unknown time" }],
            },
          ],
        },
      },
    });
    expect(update.events).toHaveLength(2);
    expect(update.events[1].time).toBeNull();
    expect(update.eventAt).toBe(Date.parse("2026-10-03T12:00:00Z"));
    expect(update).not.toHaveProperty("eta");
  });
  test("recognizes GraphQL throttling even when Shopify returns HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          }),
        ),
      ),
    );
    await expect(
      shopifyGraphql("test.myshopify.com", "secret", "query { shop { id } }"),
    ).rejects.toThrow("ProviderRateLimited");
  });
  test("encrypts stored credentials with tenant binding and rejects webhook forgery", async () => {
    vi.stubEnv("COMMERCE_ENCRYPTION_KEY", btoa("k".repeat(32)));
    const value = await encrypt("private-client-secret", "tenant-a");
    expect(value).not.toContain("private-client-secret");
    expect(await decrypt(value, "tenant-a")).toBe("private-client-secret");
    await expect(decrypt(value, "tenant-b")).rejects.toThrow();
    expect(await verifyShopify("{}", "forged", "private-client-secret")).toBe(false);
  });
});
