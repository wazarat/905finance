import type { Metadata } from "next";
import { Logo } from "@/components/brand/logo";
import { SignOut } from "./sign-out-runner";

export const metadata: Metadata = { title: "Signing out" };

export default function LogoutPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <Logo href={null} />
      <p className="mt-8 text-muted-foreground" role="status">
        Signing you out…
      </p>
      <SignOut />
    </main>
  );
}
