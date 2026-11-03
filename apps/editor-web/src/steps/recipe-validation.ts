export type RecipeValidationIssue = {
  recipeName: string | null;
  stepNames: Record<string, string>;
  instructions: Record<string, string>;
  unusableReason: string | null;
};

type RecipeLike = { id: string; name: string; steps: readonly { id: string; name: string; instruction: string }[] };

function nameKey(value: string): string {
  return value.normalize("NFKC").trim();
}

/** A recipe with ambiguous names or an empty instruction cannot be run until the owner fixes it. */
export function validateRecipeDefinition(recipe: RecipeLike, recipes: readonly Pick<RecipeLike, "id" | "name">[]): RecipeValidationIssue {
  const recipeKey = nameKey(recipe.name);
  const recipeName = recipeKey !== "" && recipes.some((other) => other.id !== recipe.id && nameKey(other.name) === recipeKey)
    ? "この手順名はほかの手順と重複しています。"
    : null;

  const nameCounts = new Map<string, number>();
  for (const step of recipe.steps) {
    const key = nameKey(step.name);
    if (key !== "") nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const stepNames: Record<string, string> = {};
  const instructions: Record<string, string> = {};
  for (const step of recipe.steps) {
    const key = nameKey(step.name);
    if (key !== "" && (nameCounts.get(key) ?? 0) > 1) stepNames[step.id] = "段階名が重複しています。";
    if (step.instruction.trim() === "") instructions[step.id] = "指示を書いてください。";
  }

  let unusableReason: string | null = recipeName;
  if (unusableReason === null && recipe.steps.length === 0) unusableReason = "段階を 1 つ以上追加してください。";
  if (unusableReason === null && Object.keys(stepNames).length > 0) unusableReason = "段階名が重複しています。設定で段階名を変えてください。";
  if (unusableReason === null && Object.keys(instructions).length > 0) {
    const step = recipe.steps.find((entry) => instructions[entry.id] !== undefined);
    unusableReason = step ? `「${step.name}」の指示が空です。設定で指示を書いてください。` : "段階の指示が空です。設定で指示を書いてください。";
  }
  return { recipeName, stepNames, instructions, unusableReason };
}
