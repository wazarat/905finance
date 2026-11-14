import type { Metadata } from "next";
import { PageHeader } from "@/components/app/page-header";
import { ProjectForm } from "./project-form";

export const metadata: Metadata = { title: "New project" };

export default function NewProjectPage() {
  return (
    <div className="max-w-3xl space-y-10">
      <PageHeader
        eyebrow="Projects"
        title="New project"
        description="One form for every kind of software. The Web3 question only changes which kinds of testing are available."
      />
      <ProjectForm />
    </div>
  );
}
