import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StoreUnavailable } from "@/components/Notice";
import { SettingsRecipeView } from "@/components/settings/SettingsRecipeView";
import { settingsPageData } from "@/settings/page-data";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const pathOf = (id: string) => `/settings/recipes/${encodeURIComponent(id)}`;

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { id } = await props.params;
  const data = await settingsPageData(pathOf(id));
  return { title: data?.settings.recipes.find((recipe) => recipe.id === id)?.name ?? "手順" };
}

/** 設定 › 手順（段階・文書ガイド・お手本・この手順だけの固有名詞）。本人の手順に無い id はどれも 404。 */
export default async function SettingsRecipePage(props: Props) {
  const { id } = await props.params;
  const data = await settingsPageData(pathOf(id));
  if (!data) return <StoreUnavailable />;
  if (!data.settings.recipes.some((recipe) => recipe.id === id)) notFound();
  return <SettingsRecipeView key={`${data.userId}:${id}`} initial={data.settings} recipeId={id} />;
}
