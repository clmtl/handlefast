/**
 * Experimental adapter for the APIs used by Shopify CLI, not the Admin API.
 * Reference: Shopify/cli @ 622b2e0984dc0bfafee4aaba78545b250fad13d3.
 * Keep this adapter isolated: the App Management API is explicitly unstable.
 */
import { z } from "zod";

const SHOPIFY_ACCESS_SCOPES_STRING = "read_orders";

const IDENTITY = "https://accounts.shopify.com";
const CLIENT_ID = "fbdb2649-e327-4907-8f67-908d24cfd7e3";
const MANAGEMENT_AUDIENCE = "7ee65a63608843c577db8b23c4d7316ea0a01bd2f7594f8a9c06ea668c1b775c";
const BUSINESS_AUDIENCE = "32ff8ee5-82b8-4d93-9f8a-c6997cefb7dc";
const MANAGEMENT_SCOPE = "https://api.shopify.com/auth/organization.apps.manage";
const BUSINESS_SCOPE = "https://api.shopify.com/auth/destinations.readonly";
const DESTINATIONS = "https://destinations.shopifysvc.com";
const MANAGEMENT = "https://app.shopify.com/app_management/unstable/graphql.json";

export class GuidedShopifyError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function normalizeShopDomain(input: string): string {
  const value = input.trim().toLowerCase();
  let domain = value;
  if (value.startsWith("https://")) {
    const url = new URL(value);
    if (url.username || url.password || url.port || url.search || url.hash)
      throw new GuidedShopifyError("INVALID_SHOP_DOMAIN");
    domain =
      url.hostname === "admin.shopify.com" && /^\/store\/[a-z0-9-]+\/?$/.test(url.pathname)
        ? `${url.pathname.split("/")[2]}.myshopify.com`
        : url.hostname;
    if (url.hostname !== "admin.shopify.com" && url.pathname !== "/")
      throw new GuidedShopifyError("INVALID_SHOP_DOMAIN");
  } else if (!domain.includes(".")) domain += ".myshopify.com";
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) || domain.length > 253)
    throw new GuidedShopifyError("INVALID_SHOP_DOMAIN");
  return domain;
}

async function request(url: string, init: RequestInit): Promise<{ ok: boolean; body: unknown }> {
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    if (text.length > 1_000_000) throw new Error("ResponseTooLarge");
    return { ok: res.ok, body: JSON.parse(text) as unknown };
  } catch {
    throw new GuidedShopifyError("SHOPIFY_REQUEST_FAILED");
  }
}
async function form(path: string, params: Record<string, string>) {
  return request(`${IDENTITY}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}
const tokenSchema = z.object({ access_token: z.string().min(1) });
async function exchange(identityToken: string, audience: string, scope: string) {
  const res = await form("/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_id: CLIENT_ID,
    audience,
    scope,
    subject_token: identityToken,
  });
  if (!res.ok) throw new GuidedShopifyError("SHOPIFY_TOKEN_EXCHANGE_FAILED");
  return tokenSchema.parse(res.body).access_token;
}
export async function beginDeviceAuthorization() {
  const res = await form("/oauth/device_authorization", {
    client_id: CLIENT_ID,
    scope: `openid ${MANAGEMENT_SCOPE} ${BUSINESS_SCOPE}`,
  });
  if (!res.ok) throw new GuidedShopifyError("SHOPIFY_AUTH_START_FAILED");
  const data = z
    .object({
      device_code: z.string().min(1),
      user_code: z.string().min(1),
      verification_uri_complete: z.string().url(),
      expires_in: z.number().positive(),
      interval: z.number().positive().optional(),
    })
    .parse(res.body);
  const url = new URL(data.verification_uri_complete);
  if (url.origin !== IDENTITY || url.username || url.password)
    throw new GuidedShopifyError("SHOPIFY_INVALID_AUTH_URL");
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: url.href,
    expiresIn: Math.min(data.expires_in, 1200),
    interval: Math.max(data.interval ?? 5, 5),
  };
}
export async function pollDeviceAuthorization(deviceCode: string) {
  const res = await form("/oauth/token", {
    client_id: CLIENT_ID,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
  });
  if (!res.ok) {
    const error = z.object({ error: z.string() }).parse(res.body).error;
    if (error === "authorization_pending" || error === "slow_down")
      return { status: error } as const;
    throw new GuidedShopifyError(
      error === "access_denied"
        ? "SHOPIFY_AUTH_DENIED"
        : error === "expired_token"
          ? "SHOPIFY_AUTH_EXPIRED"
          : "SHOPIFY_AUTH_FAILED",
    );
  }
  const identity = tokenSchema.parse(res.body).access_token;
  const [managementToken, businessToken] = await Promise.all([
    exchange(identity, MANAGEMENT_AUDIENCE, MANAGEMENT_SCOPE),
    exchange(identity, BUSINESS_AUDIENCE, BUSINESS_SCOPE),
  ]);
  return { status: "authorized", managementToken, businessToken } as const;
}
async function graphql<T>(
  url: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const authorization = /^shp(at|ua|ca|tka)/.test(token) ? token : `Bearer ${token}`;
  const res = await request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      "X-Shopify-Access-Token": authorization,
      "User-Agent": "HandleFast guided installation prototype",
    },
    body: JSON.stringify({ query, variables }),
  });
  const envelope = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.unknown()).optional(),
    })
    .safeParse(res.body);
  if (!res.ok || !envelope.success || envelope.data.errors?.length)
    throw new GuidedShopifyError("SHOPIFY_MANAGEMENT_API_FAILED");
  return schema.parse(envelope.data.data);
}
export function organizationNumber(id: string) {
  let value = id;
  if (!/^\d+$/.test(value) && !value.startsWith("gid://")) {
    try {
      value = atob(value);
    } catch {
      throw new GuidedShopifyError("SHOPIFY_INVALID_ORGANIZATION");
    }
  }
  const match = /^(?:gid:\/\/(?:organization|shopify)\/Organization\/)?(\d+)$/.exec(value);
  if (!match) throw new GuidedShopifyError("SHOPIFY_INVALID_ORGANIZATION");
  return match[1];
}
export async function listOrganizations(token: string) {
  const result = await graphql(
    `${DESTINATIONS}/destinations/api/2020-07/graphql`,
    token,
    `
			query ListOrganizations {
				currentUserAccount {
					organizationsWithAccessToDestination(destination: APPS_CLI) {
						nodes {
							id
							name
						}
					}
				}
			}
		`,
    {},
    z.object({
      currentUserAccount: z.object({
        organizationsWithAccessToDestination: z.object({
          nodes: z.array(z.object({ id: z.string(), name: z.string() })).max(500),
        }),
      }),
    }),
  );
  return result.currentUserAccount.organizationsWithAccessToDestination.nodes.map((org) => ({
    id: organizationNumber(org.id),
    name: org.name,
  }));
}
// Shopify CLI @ 1cf6e579fd5812dd2ee9922813ec6bd78363f3e9 store lookup:
// account destinations -> owning organization.
// A merchant store need not appear in an organization's developer-store directory.
export async function getStoreOrganization(token: string, shopDomain: string) {
  const requestedDomain = normalizeShopDomain(shopDomain);
  const result = await graphql(
    `${DESTINATIONS}/destinations/api/2020-07/graphql`,
    token,
    `query StoreInfoDestinations($search: String!) {
			currentUserAccount {
				destinations(search: $search, shopsOnly: true, first: 25) {
					nodes { publicId primaryDomain webUrl }
				}
			}
		}`,
    // Shopify searches handles/names, not the full myshopify.com address.
    { search: requestedDomain.split(".")[0] },
    z.object({
      currentUserAccount: z
        .object({
          destinations: z.object({
            nodes: z
              .array(
                z.object({
                  publicId: z.string().min(1),
                  primaryDomain: z.string().nullish(),
                  webUrl: z.string().nullish(),
                }),
              )
              .max(25),
          }),
        })
        .nullable(),
    }),
  );
  const matches = (result.currentUserAccount?.destinations.nodes ?? []).filter((shop) =>
    [shop.primaryDomain, shop.webUrl].some((value) => {
      if (!value) return false;
      try {
        const url = new URL(value.includes("://") ? value : `https://${value}`);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port)
          return false;
        return (
          url.hostname === requestedDomain ||
          (url.hostname === "admin.shopify.com" &&
            normalizeShopDomain(url.href) === requestedDomain)
        );
      } catch {
        return false;
      }
    }),
  );
  const destinations = [...new Set(matches.map((shop) => shop.publicId))];
  if (destinations.length !== 1) throw new GuidedShopifyError("SHOPIFY_STORE_NOT_ACCESSIBLE");
  const ownership = await graphql(
    `${DESTINATIONS}/destinations/api/2020-07/graphql`,
    token,
    `query StoreInfoOwningOrg($destinationPublicId: DestinationPublicID!) {
			currentUserAccount {
				organizationForDestination(destinationPublicId: $destinationPublicId) { id name }
			}
		}`,
    { destinationPublicId: destinations[0] },
    z.object({
      currentUserAccount: z
        .object({
          organizationForDestination: z.object({ id: z.string(), name: z.string() }).nullable(),
        })
        .nullable(),
    }),
  );
  const organization = ownership.currentUserAccount?.organizationForDestination;
  if (!organization) throw new GuidedShopifyError("SHOPIFY_STORE_ORGANIZATION_UNAVAILABLE");
  return { id: organizationNumber(organization.id), name: organization.name };
}

export function appSource(origin: string, apiVersion: string, name = "HandleFast") {
  return {
    name,
    modules: [
      {
        type: "app_home",
        config: { app_url: `${origin}/dashboard`, embedded: false },
      },
      { type: "branding", config: { name } },
      { type: "webhooks", config: { api_version: apiVersion } },
      {
        type: "app_access",
        config: {
          redirect_url_allowlist: [`${origin}/auth/shopify/callback`],
          scopes: SHOPIFY_ACCESS_SCOPES_STRING,
          use_legacy_install_flow: true,
        },
      },
    ],
  };
}
export async function createApp(
  token: string,
  organizationId: string,
  origin: string,
  apiVersion: string,
  appName = "HandleFast",
) {
  const result = await graphql(
    MANAGEMENT,
    token,
    `
			mutation CreateApp(
				$initialVersion: AppVersionInput!
				$organizationId: ID!
			) {
				appCreate(
					initialVersion: $initialVersion
					organizationId: $organizationId
				) {
					app {
						id
						key
						activeRoot {
							clientCredentials {
								secrets {
									key
								}
							}
						}
					}
					userErrors {
						message
					}
				}
			}
		`,
    {
      organizationId: `gid://shopify/Organization/${organizationNumber(organizationId)}`,
      initialVersion: {
        source: appSource(origin, apiVersion, appName),
      },
    },
    z.object({
      appCreate: z.object({
        app: z
          .object({
            id: z.string(),
            key: z.string().regex(/^[a-f0-9]{32}$/),
            activeRoot: z.object({
              clientCredentials: z.object({
                secrets: z.array(z.object({ key: z.string().min(1) })),
              }),
            }),
          })
          .nullable(),
        userErrors: z.array(z.object({ message: z.string() })),
      }),
    }),
  );
  const app = result.appCreate.app;
  if (!app && result.appCreate.userErrors.length)
    throw new GuidedShopifyError("SHOPIFY_APP_CREATE_REJECTED");
  if (!app || result.appCreate.userErrors.length || !app.activeRoot.clientCredentials.secrets[0])
    throw new GuidedShopifyError("SHOPIFY_APP_CREATE_FAILED");
  return {
    appId: app.id,
    clientId: app.key,
    apiSecretKey: app.activeRoot.clientCredentials.secrets[0].key,
  };
}

const recoverSchema = z.object({
  app: z
    .object({
      id: z.string(),
      key: z.string(),
      organizationId: z.string(),
      activeRoot: z.object({
        clientCredentials: z.object({ secrets: z.array(z.object({ key: z.string().min(1) })) }),
      }),
    })
    .nullable(),
});
export async function recoverCreatedApp(
  token: string,
  organizationId: string,
  appName: string,
  knownClientId?: string,
) {
  let clientId = knownClientId;
  if (!clientId) {
    const result = await graphql(
      MANAGEMENT,
      token,
      `query RecoverCreatedApp($query: String!) {
   appsConnection(query: $query, first: 50) { edges { node { key organizationId activeRelease { version { name } } } } pageInfo { hasNextPage } }
  }`,
      { query: `title:"${appName}"` },
      z.object({
        appsConnection: z.object({
          edges: z
            .array(
              z.object({
                node: z.object({
                  key: z.string(),
                  organizationId: z.string(),
                  activeRelease: z.object({ version: z.object({ name: z.string() }) }).nullable(),
                }),
              }),
            )
            .max(50),
          pageInfo: z.object({ hasNextPage: z.boolean() }),
        }),
      }),
    );
    const matches = result.appsConnection.edges.filter(
      ({ node }) =>
        organizationNumber(node.organizationId) === organizationNumber(organizationId) &&
        node.activeRelease?.version.name === appName,
    );
    if (result.appsConnection.pageInfo.hasNextPage || matches.length !== 1)
      throw new GuidedShopifyError("SHOPIFY_APP_RECOVERY_PENDING");
    clientId = matches[0].node.key;
  }
  const { app } = await graphql(
    MANAGEMENT,
    token,
    `query RecoverAppCredentials($apiKey: String!) {
  app: appByKey(key: $apiKey) { id key organizationId activeRoot { clientCredentials { secrets { key } } } }
 }`,
    { apiKey: clientId },
    recoverSchema,
  );
  if (
    !app ||
    app.key !== clientId ||
    organizationNumber(app.organizationId) !== organizationNumber(organizationId) ||
    !app.activeRoot.clientCredentials.secrets[0]
  )
    throw new GuidedShopifyError("SHOPIFY_APP_RECOVERY_PENDING");
  return {
    appId: app.id,
    clientId: app.key,
    apiSecretKey: app.activeRoot.clientCredentials.secrets[0].key,
  };
}
