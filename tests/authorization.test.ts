import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { completeOnboarding, enableRole, getAccountContext } from "@/server/accounts";
import type { Actor } from "@/server/authz";
import { PERMISSIONS, roleHasPermission } from "@/server/authz";
import { createProject, deleteProject, getProject, listProjects } from "@/server/projects";
import {
  createOffering,
  deleteOffering,
  getSellerListing,
  getSellerPreview,
  saveSellerEndpoint,
  submitSellerListing,
  updateSellerListing,
  withdrawSellerListing,
} from "@/server/sellers";
import {
  addMember,
  createUser,
  useTestDatabase,
  validEndpoint,
  validListing,
  validOffering,
  validProject,
} from "./support/db";

let db: Db;
let close: () => Promise<void>;

// Two unrelated organizations, each with an owner; Acme also has an admin and a member.
let acmeOwner: Actor;
let acmeAdmin: Actor;
let acmeMember: Actor;
let globexOwner: Actor;
let outsider: Actor;
let acmeOrg: string;
let globexOrg: string;
let acmeProject: string;
let globexProject: string;
let globexOffering: string;

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());

  acmeOwner = await createUser(db, "acme-owner");
  acmeAdmin = await createUser(db, "acme-admin");
  acmeMember = await createUser(db, "acme-member");
  globexOwner = await createUser(db, "globex-owner");
  outsider = await createUser(db, "outsider");

  const acme = await completeOnboarding(acmeOwner, {
    displayName: "Ada Owner",
    organizationName: "Acme Software",
    accountType: "business",
    roles: "both",
  });
  acmeOrg = acme.organization.id;
  await addMember(db, acmeOrg, acmeAdmin.userId, "admin");
  await addMember(db, acmeOrg, acmeMember.userId, "member");

  const globex = await completeOnboarding(globexOwner, {
    displayName: "Gil Owner",
    organizationName: "Globex",
    accountType: "business",
    roles: "both",
  });
  globexOrg = globex.organization.id;

  acmeProject = (await createProject(acmeOwner, acmeOrg, validProject)).id;
  globexProject = (await createProject(globexOwner, globexOrg, { ...validProject, name: "Globex app" })).id;

  await updateSellerListing(globexOwner, globexOrg, { ...validListing, displayName: "Globex Agents" });
  await saveSellerEndpoint(globexOwner, globexOrg, {
    ...validEndpoint,
    url: "https://private.globex.example/agent",
  });
  globexOffering = (await createOffering(globexOwner, globexOrg, validOffering)).id;
});
afterAll(async () => close());

describe("onboarding and roles", () => {
  it("makes the creator the owner of a new organization", async () => {
    const context = await getAccountContext(acmeOwner);
    expect(context.workspace?.organization.id).toBe(acmeOrg);
    expect(context.workspace?.role).toBe("owner");
    expect(context.user.onboardedAt).not.toBeNull();
  });

  it("lets one user hold both the buyer and seller roles", async () => {
    const context = await getAccountContext(acmeOwner);
    expect(context.workspace?.buyerProfile).not.toBeNull();
    expect(context.workspace?.sellerProfile).not.toBeNull();
  });

  it("creates only the chosen role, and seller listings start as drafts", async () => {
    const buyerOnly = await createUser(db, "buyer-only");
    const b = await completeOnboarding(buyerOnly, {
      displayName: "Bea Buyer",
      organizationName: "Buyer Only Co",
      accountType: "individual",
      roles: "buyer",
    });
    expect(b.buyerProfile).not.toBeNull();
    expect(b.sellerProfile).toBeNull();

    const sellerOnly = await createUser(db, "seller-only");
    const s = await completeOnboarding(sellerOnly, {
      displayName: "Sam Seller",
      organizationName: "Seller Only Co",
      accountType: "business",
      roles: "seller",
    });
    expect(s.buyerProfile).toBeNull();
    expect(s.sellerProfile?.status).toBe("draft");
    expect(s.sellerProfile?.isSample).toBe(false);
  });

  it("lets an owner add the other role later", async () => {
    const user = await createUser(db, "late-seller");
    const ws = await completeOnboarding(user, {
      displayName: "Lee Later",
      organizationName: "Later Co",
      accountType: "business",
      roles: "buyer",
    });
    await enableRole(user, ws.organization.id, "seller");
    const context = await getAccountContext(user);
    expect(context.workspace?.sellerProfile?.status).toBe("draft");
    // Idempotent: enabling again does not create a second listing.
    await enableRole(user, ws.organization.id, "seller");
    const listings = await db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.organizationId, ws.organization.id));
    expect(listings).toHaveLength(1);
  });

  it("refuses a second onboarding for the same user", async () => {
    await expect(
      completeOnboarding(acmeOwner, {
        displayName: "Ada Owner",
        organizationName: "Second Org",
        accountType: "business",
        roles: "buyer",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("gives organizations with the same name distinct slugs", async () => {
    const twin = await createUser(db, "twin");
    const ws = await completeOnboarding(twin, {
      displayName: "Tia Twin",
      organizationName: "Acme Software",
      accountType: "business",
      roles: "seller",
    });
    const [acme] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, acmeOrg));
    expect(ws.organization.slug).not.toBe(acme.slug);
  });

  it("only owners may enable a role", async () => {
    await expect(enableRole(acmeAdmin, acmeOrg, "seller")).rejects.toMatchObject({ code: "forbidden" });
    await expect(enableRole(acmeMember, acmeOrg, "buyer")).rejects.toMatchObject({ code: "forbidden" });
    await expect(enableRole(globexOwner, acmeOrg, "buyer")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("unauthenticated callers", () => {
  // Every protected data-layer entry point, called with no actor.
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["getAccountContext", () => getAccountContext(null)],
    ["completeOnboarding", () => completeOnboarding(null, {})],
    ["enableRole", () => enableRole(null, MISSING_ID, "buyer")],
    ["listProjects", () => listProjects(null, MISSING_ID)],
    ["getProject", () => getProject(null, MISSING_ID)],
    ["createProject", () => createProject(null, MISSING_ID, validProject)],
    ["deleteProject", () => deleteProject(null, MISSING_ID)],
    ["getSellerListing", () => getSellerListing(null, MISSING_ID)],
    ["getSellerPreview", () => getSellerPreview(null, MISSING_ID)],
    ["updateSellerListing", () => updateSellerListing(null, MISSING_ID, validListing)],
    ["saveSellerEndpoint", () => saveSellerEndpoint(null, MISSING_ID, validEndpoint)],
    ["createOffering", () => createOffering(null, MISSING_ID, validOffering)],
    ["deleteOffering", () => deleteOffering(null, MISSING_ID, MISSING_ID)],
    ["submitSellerListing", () => submitSellerListing(null, MISSING_ID)],
    ["withdrawSellerListing", () => withdrawSellerListing(null, MISSING_ID)],
  ];

  it.each(calls)("%s is rejected", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects an actor whose id is not a real user id", async () => {
    await expect(listProjects({ userId: "1 OR 1=1" }, acmeOrg)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("with real targets, still performs no action", async () => {
    await expect(createProject(null, acmeOrg, validProject)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(deleteProject(null, acmeProject)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await listProjects(acmeOwner, acmeOrg)).toHaveLength(1);
  });
});

describe("isolation between organizations", () => {
  it("does not list another organization's projects", async () => {
    await expect(listProjects(acmeOwner, globexOrg)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listProjects(outsider, acmeOrg)).rejects.toMatchObject({ code: "forbidden" });
    const own = await listProjects(acmeOwner, acmeOrg);
    expect(own.map((p) => p.id)).toEqual([acmeProject]);
  });

  it("reports another organization's project as not found, exactly like a missing one", async () => {
    const foreign = await getProject(acmeOwner, globexProject).catch((e) => e);
    const missing = await getProject(acmeOwner, MISSING_ID).catch((e) => e);
    expect(foreign).toMatchObject({ code: "not_found" });
    expect(missing).toMatchObject({ code: "not_found" });
    expect(foreign.message).toBe(missing.message);
    await expect(getProject(acmeOwner, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
  });

  it("cannot create a project in another organization", async () => {
    await expect(createProject(acmeOwner, globexOrg, validProject)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await listProjects(globexOwner, globexOrg)).toHaveLength(1);
  });

  it("cannot delete another organization's project", async () => {
    await expect(deleteProject(acmeOwner, globexProject)).rejects.toMatchObject({ code: "not_found" });
    expect((await getProject(globexOwner, globexProject)).id).toBe(globexProject);
  });

  it("cannot read another organization's private listing or endpoint", async () => {
    await expect(getSellerListing(acmeOwner, globexOrg)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getSellerPreview(acmeOwner, globexOrg)).rejects.toMatchObject({ code: "forbidden" });
    const own = await getSellerListing(globexOwner, globexOrg);
    expect(own?.endpoint?.url).toBe("https://private.globex.example/agent");
  });

  it("cannot edit another organization's listing, endpoint or offerings", async () => {
    await expect(
      updateSellerListing(acmeOwner, globexOrg, { ...validListing, displayName: "Hijacked" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      saveSellerEndpoint(acmeOwner, globexOrg, { ...validEndpoint, url: "https://attacker.example/x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(createOffering(acmeOwner, globexOrg, validOffering)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(submitSellerListing(acmeOwner, globexOrg)).rejects.toMatchObject({
      code: "forbidden",
    });

    const listing = await getSellerListing(globexOwner, globexOrg);
    expect(listing?.profile.displayName).toBe("Globex Agents");
    expect(listing?.endpoint?.url).toBe("https://private.globex.example/agent");
    expect(listing?.offerings).toHaveLength(1);
    expect(listing?.profile.status).toBe("draft");
  });

  it("cannot delete another organization's offering by naming its id under one's own organization", async () => {
    await expect(deleteOffering(acmeOwner, acmeOrg, globexOffering)).rejects.toMatchObject({
      code: "not_found",
    });
    const listing = await getSellerListing(globexOwner, globexOrg);
    expect(listing?.offerings.map((o) => o.id)).toEqual([globexOffering]);
  });
});

describe("roles within an organization", () => {
  it("lets every member view and create projects", async () => {
    expect(await listProjects(acmeMember, acmeOrg)).toHaveLength(1);
    const created = await createProject(acmeMember, acmeOrg, { ...validProject, name: "Member project" });
    expect((await getProject(acmeAdmin, created.id)).name).toBe("Member project");
    await deleteProject(acmeAdmin, created.id);
  });

  it("does not let a plain member delete projects", async () => {
    await expect(deleteProject(acmeMember, acmeProject)).rejects.toMatchObject({ code: "forbidden" });
    expect((await getProject(acmeOwner, acmeProject)).id).toBe(acmeProject);
  });

  it("lets a member view the seller listing but not change it", async () => {
    expect((await getSellerListing(acmeMember, acmeOrg))?.profile.status).toBe("draft");
    await expect(updateSellerListing(acmeMember, acmeOrg, validListing)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(saveSellerEndpoint(acmeMember, acmeOrg, validEndpoint)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(createOffering(acmeMember, acmeOrg, validOffering)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(submitSellerListing(acmeMember, acmeOrg)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("lets an admin manage the seller listing", async () => {
    const updated = await updateSellerListing(acmeAdmin, acmeOrg, validListing);
    expect(updated.displayName).toBe(validListing.displayName);
  });

  it("keeps organization-level changes owner-only in the permission table", () => {
    expect(PERMISSIONS["org.update"]).toEqual(["owner"]);
    expect(PERMISSIONS["org.enable_role"]).toEqual(["owner"]);
    expect(roleHasPermission("member", "seller_listing.manage")).toBe(false);
    expect(roleHasPermission("admin", "org.update")).toBe(false);
  });
});

describe("audit trail", () => {
  it("records sensitive actions with the acting user and organization", async () => {
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.organizationId, acmeOrg));
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "organization.created",
        "buyer_profile.created",
        "seller_profile.created",
        "project.created",
        "seller_profile.updated",
      ]),
    );
    const created = events.find((e) => e.action === "project.created");
    expect(created?.actorUserId).toBe(acmeOwner.userId);
    expect(created?.metadata).toMatchObject({ testingAuthorized: true });
  });

  it("records nothing for rejected attempts", async () => {
    const before = (await db.select().from(schema.auditEvents)).length;
    await createProject(outsider, acmeOrg, validProject).catch(() => undefined);
    await updateSellerListing(acmeMember, acmeOrg, validListing).catch(() => undefined);
    expect((await db.select().from(schema.auditEvents)).length).toBe(before);
  });
});
