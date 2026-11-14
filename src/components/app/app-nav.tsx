"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  CircleCheck,
  ClipboardCheck,
  Compass,
  FolderGit2,
  Handshake,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Settings,
  Store,
  Tags,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon; exact?: boolean };

const BUYING: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/engagements", label: "Engagements", icon: Handshake },
  { href: "/reports", label: "Test reports", icon: ClipboardCheck },
  { href: "/approvals", label: "Approvals", icon: CircleCheck },
  { href: "/wallets", label: "Wallets", icon: Wallet },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/agents", label: "Explore agents", icon: Compass },
];

const SELLING: NavItem[] = [
  { href: "/seller", label: "Seller dashboard", icon: Store, exact: true },
  { href: "/seller/listing", label: "Listing", icon: Tags },
];

const ACCOUNT: NavItem[] = [
  { href: "/audit", label: "Activity log", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active ? "text-brand" : "")} aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function SidebarNavView({ pathname }: { pathname: string }) {
  const groups = [
    { label: "Buying", items: BUYING },
    { label: "Selling", items: SELLING },
    { label: "Account", items: ACCOUNT },
  ];
  return (
    <nav aria-label="Workspace" className="space-y-6">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="eyebrow px-3 pb-2">{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.href}>
                <NavLink item={item} pathname={pathname} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function MobileNavView({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Workspace" className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
      <ul className="flex gap-1 py-2">
        {[...BUYING, ...SELLING, ...ACCOUNT].map((item) => (
          <li key={item.href}>
            <NavLink item={item} pathname={pathname} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function CurrentSidebarNav() {
  return <SidebarNavView pathname={usePathname()} />;
}

function CurrentMobileNav() {
  return <MobileNavView pathname={usePathname()} />;
}

// The current path is only known at request time, so the links render first
// without a highlighted item and the active state streams in.

/** Sidebar navigation on wide screens. */
export function SidebarNav() {
  return (
    <Suspense fallback={<SidebarNavView pathname="" />}>
      <CurrentSidebarNav />
    </Suspense>
  );
}

/** Horizontally scrolling navigation on narrow screens. */
export function MobileNav() {
  return (
    <Suspense fallback={<MobileNavView pathname="" />}>
      <CurrentMobileNav />
    </Suspense>
  );
}
