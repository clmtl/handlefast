/// <reference types="vite/client" />

import betterAuthTest from "@convex-dev/better-auth/test";
import type { UserIdentity } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const issuer = "https://handlefast-test.convex.site";

function createTestBackend() {
  const t = convexTest({ schema, modules });
  betterAuthTest.register(t);
  return t;
}

async function createAuthenticatedClient(
  t: ReturnType<typeof createTestBackend>,
  seed: string,
  options: { emailVerified?: boolean } = {},
) {
  const now = Date.now();
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `User ${seed}`,
        email: `${seed}@example.com`,
        emailVerified: options.emailVerified ?? true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string; email: string; name: string };

  const session = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        token: `session-${seed}`,
        userId: user._id,
        expiresAt: now + 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };

  const tokenIdentifier = `${issuer}|${user._id}`;
  const identity = {
    issuer,
    subject: user._id,
    tokenIdentifier,
    sessionId: session._id,
    email: user.email,
    name: user.name,
  } as Partial<UserIdentity> & { sessionId: string };

  return {
    authUserId: user._id,
    client: t.withIdentity(identity),
    tokenIdentifier,
  };
}

async function createWorkspace(t: ReturnType<typeof createTestBackend>, seed: string) {
  const auth = await createAuthenticatedClient(t, seed);
  const result = await auth.client.mutation(api.onboarding.bootstrap, {
    organizationName: `${seed} Organization`,
    shopName: `${seed} Shop`,
  });

  if (!result.shopId) {
    throw new Error("Expected a freshly created workspace to include a shop id");
  }

  return {
    ...auth,
    ...result,
    shopId: result.shopId,
  };
}

async function countTenantRows(t: ReturnType<typeof createTestBackend>) {
  return await t.run(async (ctx) => {
    const profiles = await ctx.db.query("profiles").take(20);
    const organizations = await ctx.db.query("organizations").take(20);
    const memberships = await ctx.db.query("memberships").take(20);
    const shops = await ctx.db.query("shops").take(20);
    const shopSettings = await ctx.db.query("shopSettings").take(20);

    return {
      profiles: profiles.length,
      organizations: organizations.length,
      memberships: memberships.length,
      shops: shops.length,
      shopSettings: shopSettings.length,
    };
  });
}

async function createProfileWithRole(
  t: ReturnType<typeof createTestBackend>,
  organizationId: Id<"organizations">,
  role: "admin" | "agent" | "viewer",
  seed: string,
) {
  const auth = await createAuthenticatedClient(t, seed);
  const profileId = await t.run(async (ctx) => {
    const now = Date.now();
    const createdProfileId = await ctx.db.insert("profiles", {
      authUserId: auth.authUserId,
      authTokenIdentifier: auth.tokenIdentifier,
      email: `${seed}@example.com`,
      name: `User ${seed}`,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("memberships", {
      organizationId,
      profileId: createdProfileId,
      role,
      createdAt: now,
      updatedAt: now,
    });

    return createdProfileId;
  });

  return {
    ...auth,
    profileId,
  };
}

describe("auth and SaaS foundation", () => {
  test("rejects unauthenticated app queries and mutations", async () => {
    const t = createTestBackend();

    await expect(t.query(api.viewer.me)).rejects.toThrow("Unauthenticated");
    await expect(t.mutation(api.onboarding.bootstrap, {})).rejects.toThrow("Unauthenticated");
    await expect(t.query(api.organizations.list)).rejects.toThrow("Unauthenticated");
  });

  test("rejects sessions whose auth user record is missing", async () => {
    const t = createTestBackend();
    const now = Date.now();
    const session = (await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          token: "session-missing-user",
          userId: "missing-user",
          expiresAt: now + 60 * 60 * 1000,
          createdAt: now,
          updatedAt: now,
        },
      },
    })) as { _id: string };
    const client = t.withIdentity({
      issuer,
      subject: "missing-user",
      tokenIdentifier: `${issuer}|missing-user`,
      sessionId: session._id,
    } as Partial<UserIdentity> & { sessionId: string });

    await expect(client.query(api.viewer.me)).rejects.toThrow("Unauthenticated");
  });

  test("rejects unverified email sessions before trusting profile data", async () => {
    const t = createTestBackend();
    const auth = await createAuthenticatedClient(t, "unverified", {
      emailVerified: false,
    });

    await expect(auth.client.query(api.viewer.me)).rejects.toThrow("EmailVerificationRequired");
    await expect(auth.client.mutation(api.onboarding.bootstrap, {})).rejects.toThrow(
      "EmailVerificationRequired",
    );
  });

  test("returns an authenticated viewer state before onboarding is complete", async () => {
    const t = createTestBackend();
    const auth = await createAuthenticatedClient(t, "pre-onboarding");

    const viewer = await auth.client.query(api.viewer.me);

    expect(viewer.profile).toBeNull();
    expect(viewer.organizations).toEqual([]);
    expect(viewer.memberships).toEqual([]);
    expect(viewer.shops).toEqual([]);
    expect(viewer.shopSettings).toEqual([]);
    expect(viewer.hasCompletedOnboarding).toBe(false);
    expect(viewer).not.toHaveProperty("authUser");
    expect(viewer).not.toHaveProperty("tokenIdentifier");
  });

  test("bootstraps the first profile, organization, owner membership, shop, and settings", async () => {
    const t = createTestBackend();
    const auth = await createAuthenticatedClient(t, "owner");

    const result = await auth.client.mutation(api.onboarding.bootstrap, {
      organizationName: "Owner Company",
      shopName: "Owner Shop",
    });
    const viewer = await auth.client.query(api.viewer.me);

    expect(result.created).toBe(true);
    expect(viewer.profile?.authUserId).toBe(auth.authUserId);
    expect(viewer.organizations[0]?.slug).toBe("owner-company");
    expect(viewer.organizations).toHaveLength(1);
    expect(viewer.memberships).toMatchObject([{ role: "owner" }]);
    expect(viewer.shops).toMatchObject([{ name: "Owner Shop", platform: "manual" }]);
    expect(viewer.shopSettings).toMatchObject([{ autoReplyEnabled: false }]);
    expect(viewer.hasCompletedOnboarding).toBe(true);
  });

  test("lists only organizations where the current profile is a member", async () => {
    const t = createTestBackend();
    const first = await createWorkspace(t, "list-first");
    const second = await createWorkspace(t, "list-second");

    const firstOrganizations = await first.client.query(api.organizations.list);
    const secondOrganizations = await second.client.query(api.organizations.list);

    expect(firstOrganizations).toHaveLength(1);
    expect(firstOrganizations[0]?.organization._id).toBe(first.organizationId);
    expect(firstOrganizations[0]?.organization._id).not.toBe(second.organizationId);
    expect(secondOrganizations).toHaveLength(1);
    expect(secondOrganizations[0]?.organization._id).toBe(second.organizationId);
  });

  test("keeps onboarding idempotent for an existing owner", async () => {
    const t = createTestBackend();
    const auth = await createAuthenticatedClient(t, "idempotent");

    const first = await auth.client.mutation(api.onboarding.bootstrap, {
      organizationName: "Stable Company",
      shopName: "Stable Shop",
    });
    const second = await auth.client.mutation(api.onboarding.bootstrap, {
      organizationName: "Ignored Company",
      shopName: "Ignored Shop",
    });
    const counts = await countTenantRows(t);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.organizationId).toBe(first.organizationId);
    expect(counts).toEqual({
      profiles: 1,
      organizations: 1,
      memberships: 1,
      shops: 1,
      shopSettings: 1,
    });
  });

  test("denies organization and shop reads to non-members", async () => {
    const t = createTestBackend();
    const first = await createWorkspace(t, "first");
    const second = await createWorkspace(t, "second");

    await expect(
      second.client.query(api.organizations.get, {
        organizationId: first.organizationId,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      second.client.query(api.shops.getWithSettings, {
        shopId: first.shopId,
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("reads and updates shop settings through organization membership", async () => {
    const t = createTestBackend();
    const owner = await createWorkspace(t, "settings-owner");

    const initial = await owner.client.query(api.shops.getWithSettings, {
      shopId: owner.shopId,
    });

    expect(initial.settings).toMatchObject({
      autoReplyEnabled: false,
      locale: "en",
      timezone: "UTC",
    });

    await owner.client.mutation(api.shops.updateSettings, {
      autoReplyEnabled: true,
      escalationEmail: "support-manager@example.com",
      locale: "fr",
      shopId: owner.shopId,
      supportEmail: "support@example.com",
      timezone: "Europe/Paris",
    });

    const updated = await owner.client.query(api.shops.getWithSettings, {
      shopId: owner.shopId,
    });

    expect(updated.shop.supportEmail).toBe("support@example.com");
    expect(updated.settings).toMatchObject({
      autoReplyEnabled: true,
      escalationEmail: "support-manager@example.com",
      locale: "fr",
      timezone: "Europe/Paris",
    });

    await owner.client.mutation(api.shops.updateSettings, {
      escalationEmail: "",
      shopId: owner.shopId,
      supportEmail: "   ",
    });

    const cleared = await owner.client.query(api.shops.getWithSettings, {
      shopId: owner.shopId,
    });

    expect(cleared.shop.supportEmail).toBeUndefined();
    expect(cleared.settings?.escalationEmail).toBeUndefined();
  });

  test("denies shop settings updates to non-members", async () => {
    const t = createTestBackend();
    const owner = await createWorkspace(t, "settings-owner-deny");
    const other = await createWorkspace(t, "settings-other-deny");

    await expect(
      other.client.mutation(api.shops.updateSettings, {
        autoReplyEnabled: true,
        shopId: owner.shopId,
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("allows owner and admin management while denying agent and viewer", async () => {
    const t = createTestBackend();
    const owner = await createWorkspace(t, "role-owner");
    const admin = await createProfileWithRole(t, owner.organizationId, "admin", "role-admin");
    const agent = await createProfileWithRole(t, owner.organizationId, "agent", "role-agent");
    const viewer = await createProfileWithRole(t, owner.organizationId, "viewer", "role-viewer");

    await expect(
      owner.client.mutation(api.organizations.updateName, {
        organizationId: owner.organizationId,
        name: "Owner renamed",
      }),
    ).resolves.toBe(owner.organizationId);
    await expect(
      admin.client.mutation(api.organizations.updateName, {
        organizationId: owner.organizationId,
        name: "Admin renamed",
      }),
    ).resolves.toBe(owner.organizationId);
    await expect(
      agent.client.mutation(api.organizations.updateName, {
        organizationId: owner.organizationId,
        name: "Agent renamed",
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      viewer.client.mutation(api.organizations.updateName, {
        organizationId: owner.organizationId,
        name: "Viewer renamed",
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("allows admin shop management while denying agent and viewer shop management", async () => {
    const t = createTestBackend();
    const owner = await createWorkspace(t, "shop-role-owner");
    const admin = await createProfileWithRole(t, owner.organizationId, "admin", "shop-role-admin");
    const agent = await createProfileWithRole(t, owner.organizationId, "agent", "shop-role-agent");
    const viewer = await createProfileWithRole(
      t,
      owner.organizationId,
      "viewer",
      "shop-role-viewer",
    );

    await expect(
      admin.client.mutation(api.shops.updateSettings, {
        autoReplyEnabled: true,
        shopId: owner.shopId,
      }),
    ).resolves.toBeDefined();
    await expect(
      agent.client.mutation(api.shops.updateSettings, {
        autoReplyEnabled: false,
        shopId: owner.shopId,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      viewer.client.mutation(api.shops.updateSettings, {
        autoReplyEnabled: false,
        shopId: owner.shopId,
      }),
    ).rejects.toThrow("Forbidden");
  });
});
