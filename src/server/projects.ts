import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Project } from "@/db/schema";
import { recordAudit } from "./audit";
import {
  assertAuthenticated,
  isUuid,
  requirePermission,
  requirePermissionOnRecord,
  type Actor,
} from "./authz";
import { conflict, notFound } from "./errors";
import { parseInput, projectInput } from "./validation";

const { projects } = schema;

export async function listProjects(actor: Actor | null, organizationId: string): Promise<Project[]> {
  await requirePermission(actor, organizationId, "project.view");
  return getDb()
    .select()
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .orderBy(desc(projects.createdAt));
}

export async function getProject(actor: Actor | null, projectId: string): Promise<Project> {
  assertAuthenticated(actor);
  if (!isUuid(projectId)) throw notFound("Project");
  const [project] = await getDb().select().from(projects).where(eq(projects.id, projectId));
  await requirePermissionOnRecord(actor, project, "project.view", "Project");
  return project;
}

/**
 * Create a project. The caller must explicitly confirm they are authorized to
 * have the target tested; the confirmation is stored with who gave it and when.
 */
export async function createProject(
  actor: Actor | null,
  organizationId: string,
  rawInput: unknown,
): Promise<Project> {
  await requirePermission(actor, organizationId, "project.create");
  assertAuthenticated(actor);
  const input = parseInput(projectInput, rawInput);

  return getDb().transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        organizationId,
        name: input.name,
        description: input.description,
        sourceType: input.sourceType,
        repositoryUrl: input.sourceType === "repository" ? input.repositoryUrl : null,
        fixtureKey: input.sourceType === "fixture" ? input.fixtureKey : null,
        applicationUrl: input.applicationUrl || null,
        testingObjectives: input.testingObjectives,
        hasWeb3: input.hasWeb3,
        testingAuthorizedAt: new Date(),
        testingAuthorizedBy: actor.userId,
        createdBy: actor.userId,
      })
      .returning();
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "project.created",
        entityType: "project",
        entityId: project.id,
        metadata: {
          hasWeb3: project.hasWeb3,
          sourceType: project.sourceType,
          testingAuthorized: true,
        },
      },
      tx,
    );
    return project;
  });
}

export async function deleteProject(actor: Actor | null, projectId: string): Promise<void> {
  assertAuthenticated(actor);
  if (!isUuid(projectId)) throw notFound("Project");
  await getDb().transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId));
    await requirePermissionOnRecord(actor, project, "project.delete", "Project", tx);
    const [engagement] = await tx
      .select({ id: schema.engagements.id })
      .from(schema.engagements)
      .where(eq(schema.engagements.projectId, projectId))
      .limit(1);
    if (engagement) {
      throw conflict("This project has engagements, so it is kept as part of their record.");
    }
    await tx.delete(projects).where(eq(projects.id, projectId));
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId: project.organizationId,
        action: "project.deleted",
        entityType: "project",
        entityId: project.id,
        metadata: { name: project.name },
      },
      tx,
    );
  });
}
