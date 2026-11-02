import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginView } from "@/components/LoginView";
import { loginErrorOf, safeReturnTo } from "@/auth/return-to";
import { currentSession, sessionRecoveryEnabled } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ログイン" };

type SearchParams = { next?: string | string[]; error?: string | string[]; recover?: string | string[] };

/** NIHO アカウントでのログイン（枠の外）。ログイン済みなら戻り先へ。戻り先は editor の中の path だけ。 */
export default async function LoginPage(props: { searchParams: Promise<SearchParams> }) {
  const { next, error, recover } = await props.searchParams;
  const returnTo = safeReturnTo(typeof next === "string" ? next : null);
  if (await currentSession()) redirect(returnTo);
  return <LoginView
    next={returnTo === "/" ? null : returnTo}
    error={loginErrorOf(error)}
    recover={recover === "1" && sessionRecoveryEnabled()}
  />;
}
