"use client";

import Link from "next/link";
import { ChevronsUpDown, LogOut, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({
  name,
  email,
  organization,
  role,
}: {
  name: string;
  email: string | null;
  organization: string;
  role: string;
}) {
  const initial = (name || email || "?").trim().charAt(0).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 py-2 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-dim font-medium text-brand"
          aria-hidden="true"
        >
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{organization}</span>
          <span className="block truncate text-xs text-muted-foreground">{name || email}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Open account menu</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="space-y-0.5">
          <span className="block truncate text-sm text-foreground">{name || "Account"}</span>
          {email ? <span className="block truncate text-xs font-normal text-muted-foreground">{email}</span> : null}
          <span className="block text-xs font-normal text-muted-foreground capitalize">
            {role} · {organization}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings aria-hidden="true" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/logout" prefetch={false}>
            <LogOut aria-hidden="true" />
            Sign out
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
