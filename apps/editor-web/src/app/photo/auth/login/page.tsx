import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loginErrorOf, safePhotoReturnTo } from "@/auth/return-to";
import { LoginView } from "@/components/LoginView";
import { currentPhotoSession } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ログイン" };

type SearchParams = { next?: string | string[]; error?: string | string[] };

/** 写真だけのNIHOログイン。DocsのGoogle sessionは写真の本人として扱わない。 */
export default async function PhotoLoginPage(props: { searchParams: Promise<SearchParams> }) {
  const { next, error } = await props.searchParams;
  const returnTo = safePhotoReturnTo(typeof next === "string" ? next : null);
  if (await currentPhotoSession()) redirect(returnTo);
  return <LoginView next={returnTo === "/photo" ? null : returnTo} error={loginErrorOf(error)} startPath="/photo/auth/start" />;
}
