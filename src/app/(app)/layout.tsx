import { Suspense } from "react";
import { MobileNav, SidebarNav } from "@/components/app/app-nav";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { UserMenu } from "@/components/app/user-menu";
import { Logo } from "@/components/brand/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { requireWorkspace } from "@/server/page-context";

async function Account() {
  const { user, workspace } = await requireWorkspace();
  return (
    <UserMenu
      name={user.displayName ?? ""}
      email={user.email}
      organization={workspace.organization.name}
      role={workspace.role}
    />
  );
}

/**
 * Gate for every signed-in page: resolves the verified session before any
 * child renders. Signed-out visitors are redirected to login and users without
 * an organization to onboarding. Pages and the data layer repeat the check.
 */
async function WorkspaceGate({ children }: { children: React.ReactNode }) {
  await requireWorkspace();
  return <>{children}</>;
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  const account = (
    <Suspense fallback={<Skeleton className="h-12 w-full rounded-lg" />}>
      <Account />
    </Suspense>
  );
  return (
    <div className="flex min-h-full flex-1 flex-col lg:flex-row">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="sticky top-0 flex h-dvh flex-col gap-8 px-4 py-5">
          <div className="px-2">
            <Logo href="/dashboard" />
          </div>
          <div className="flex-1 overflow-y-auto">
            <SidebarNav />
          </div>
          {account}
        </div>
      </aside>

      <div className="sticky top-0 z-30 border-b border-sidebar-border bg-sidebar/95 px-4 backdrop-blur-md lg:hidden">
        <div className="flex h-14 items-center justify-between gap-4">
          <Logo href="/dashboard" />
          <div className="w-52 max-w-[55%]">{account}</div>
        </div>
        <MobileNav />
      </div>

      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
          <Suspense fallback={<PageSkeleton />}>
            <WorkspaceGate>{children}</WorkspaceGate>
          </Suspense>
        </div>
      </main>
    </div>
  );
}
