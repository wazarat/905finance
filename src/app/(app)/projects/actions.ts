"use server";

import { redirect } from "next/navigation";
import { failureState, formValues, text, type FormState } from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";
import { FILE_LIMITS } from "@/lib/repository";
import { createProject, deleteProject } from "@/server/projects";

export async function createProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let projectId: string;
  try {
    const { actor, workspace } = await requireActionWorkspace();
    const web3 = text(formData, "hasWeb3");
    // Shared source files arrive as uploads. They are text to be read by a scan, never executed.
    const uploads = formData.getAll("files").filter((entry): entry is File => entry instanceof File && entry.size > 0);
    const oversize = uploads.find((file) => file.size > FILE_LIMITS.bytesEach);
    if (oversize || uploads.length > FILE_LIMITS.files) {
      return {
        ok: false,
        message: "Check the highlighted fields.",
        fieldErrors: {
          files: [
            oversize
              ? `"${oversize.name.slice(0, 60)}" is larger than ${FILE_LIMITS.bytesEach / 1024} KB.`
              : `Share at most ${FILE_LIMITS.files} files.`,
          ],
        },
        values: formValues(formData),
      };
    }
    const files = await Promise.all(uploads.map(async (file) => ({ name: file.name, content: await file.text() })));
    const project = await createProject(actor, workspace.organization.id, {
      name: text(formData, "name"),
      description: text(formData, "description"),
      sourceType: text(formData, "sourceType"),
      repositoryUrl: text(formData, "repositoryUrl") || undefined,
      fixtureKey: text(formData, "fixtureKey") || undefined,
      applicationUrl: text(formData, "applicationUrl") || undefined,
      contractAddresses: text(formData, "contractAddresses") || undefined,
      files,
      testingObjectives: text(formData, "testingObjectives"),
      // Left undefined when unanswered so the question cannot be skipped.
      hasWeb3: web3 === "yes" ? true : web3 === "no" ? false : undefined,
      testingAuthorized: formData.get("testingAuthorized") === "on",
    });
    projectId = project.id;
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  redirect(`/projects/${projectId}`);
}

export async function deleteProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await deleteProject(actor, text(formData, "projectId"));
  } catch (error) {
    return failureState(error);
  }
  redirect("/projects");
}
