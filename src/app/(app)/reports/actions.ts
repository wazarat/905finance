"use server";

import { refresh } from "next/cache";
import { failureState, text, type FormState } from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";
import { requeueTestingJob } from "@/server/testing/jobs";

/** Put a test that could not run back in the queue. Nothing is bought or charged. */
export async function requeueJobAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await requeueTestingJob(actor, text(formData, "jobId"));
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Queued again. Nothing was charged." };
}
