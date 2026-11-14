import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@/db/schema";
import { getAccountContext, type Workspace } from "./accounts";
import { getActor, requireUser } from "./auth/actor";
import type { Actor } from "./authz";
import { forbidden, unauthenticated } from "./errors";

export type WorkspaceContext = { actor: Actor; user: User; workspace: Workspace };

/**
 * For signed-in pages: the verified user and their organization.
 * Signed-out visitors go to login; users who have not onboarded go to onboarding.
 */
export const requireWorkspace = cache(async (): Promise<WorkspaceContext> => {
  const user = await requireUser();
  const actor: Actor = { userId: user.id };
  const context = await getAccountContext(actor);
  if (!context.workspace) redirect("/onboarding");
  return { actor, user: context.user, workspace: context.workspace };
});

/**
 * For server actions: same lookup, but failures are raised as errors rather
 * than redirects. The organization always comes from the verified session,
 * never from anything the form submitted.
 */
export async function requireActionWorkspace(): Promise<WorkspaceContext> {
  const actor = await getActor();
  if (!actor) throw unauthenticated();
  const context = await getAccountContext(actor);
  if (!context.workspace) throw forbidden("Finish setting up your organization first.");
  return { actor, user: context.user, workspace: context.workspace };
}
