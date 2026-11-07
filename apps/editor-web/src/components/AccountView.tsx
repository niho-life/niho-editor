"use client";

import { useRouter } from "next/navigation";
import { EditorAccountPage } from "niho-docs-ui/shell";
import type { FrameMe } from "./EditorFrame";

export function AccountView({ account, refreshIdentity, identityMismatch }: { account: FrameMe; refreshIdentity?: boolean; identityMismatch?: boolean }) {
  const router = useRouter();
  return <EditorAccountPage account={account} refreshIdentity={refreshIdentity} identityMismatch={identityMismatch} onNavigate={(href) => router.push(href)} />;
}
