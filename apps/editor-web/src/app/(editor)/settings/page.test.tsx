import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/auth/types";

const { session, redirect } = vi.hoisted(() => ({
  session: vi.fn<() => Promise<Session>>(),
  redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/session", () => ({ requireSession: session }));
vi.mock("@/settings/page-data", () => ({ settingsPageData: async () => ({ userId: "synthetic-user", settings: {} }) }));
vi.mock("@/settings/facts", () => ({ settingsFacts: () => ({ transcription: { audio: { maxBytes: 1024, maxDurationSec: 60, retentionDays: 30 } } }) }));
vi.mock("@/server/connections-deps", () => ({ connectionsDeps: { ports: () => ({}), counts: () => ({}) } }));
vi.mock("@/server/connections-api", () => ({ destinationsFor: async () => ({ faces: [], sites: [] }) }));
vi.mock("@/components/settings/SettingsHubView", () => ({ SettingsHubView: () => null }));

import SettingsPage from "./page";
import AccountPage from "../account/page";

beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ userId: "synthetic-user", mode: "niho" });
});

describe("設定の本人情報", () => {
  it.each([
    { mode: "niho", name: "合成の名前", recover: false },
    { mode: "niho", name: undefined, recover: true },
    { mode: "niho", name: "  ", recover: true },
    { mode: "stub", name: undefined, recover: false },
    { mode: "google", name: undefined, recover: false },
  ] as const)("$mode / name=$name の名前再取得は $recover", async ({ mode, name, recover }) => {
    session.mockResolvedValue({ userId: "synthetic-user", mode, ...(name === undefined ? {} : { profile: { name } }) });
    const result = await SettingsPage({ searchParams: Promise.resolve({}) }) as ReactElement<{ refreshIdentity: boolean; account: { name: string } }>;
    expect(result.props.refreshIdentity).toBe(recover);
    expect(result.props.account.name).toBe(name?.trim() || "名前を取得できません");
  });

  it("別の本人を選んだ場合の通知を設定へ渡す", async () => {
    const result = await SettingsPage({ searchParams: Promise.resolve({ identity: "mismatch" }) }) as ReactElement<{ identityMismatch: boolean }>;
    expect(result.props.identityMismatch).toBe(true);
  });
});

describe("旧アカウントページ", () => {
  it.each([
    [{}, "/settings"],
    [{ identity: "mismatch" }, "/settings?identity=mismatch"],
    [{ identity: "ignored" }, "/settings"],
  ])("%j を %s へ転送する", async (query, expected) => {
    await expect(AccountPage({ searchParams: Promise.resolve(query) })).rejects.toThrow(`redirect:${expected}`);
    expect(redirect).toHaveBeenCalledWith(expected);
  });
});
