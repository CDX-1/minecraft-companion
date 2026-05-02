export type RecipeItem = { id: number; name: string };

export type Recipe = {
  ingredients?: Array<number | null>;
  inShape?: Array<Array<number | null>>;
  result?: { id: number; count?: number };
  requiresTable?: boolean;
};

export type RecipeData = {
  itemsByName: Record<string, RecipeItem>;
  items: Record<number, RecipeItem> | RecipeItem[];
  recipes: Record<number, Recipe[]>;
};

export type RecipeKnowledge = {
  itemsByName: Record<string, RecipeItem>;
  itemsById: Record<number, RecipeItem>;
  recipesByResultId: Record<number, Recipe[]>;
};

export type InventoryCounts = Record<string, number>;

export type DependencyStep = {
  output: string;
  count: number;
  crafts: number;
  ingredients: Array<{ name: string; count: number }>;
  requiresTable: boolean;
};

export type DependencyPlan = {
  target: string;
  count: number;
  canCraftFromInventory: boolean;
  missingBaseItems: Array<{ name: string; count: number }>;
  craftingSteps: DependencyStep[];
  errors: string[];
};

export function createRecipeKnowledge(data: RecipeData): RecipeKnowledge {
  const itemsById: Record<number, RecipeItem> = {};
  if (Array.isArray(data.items)) {
    for (const item of data.items) itemsById[item.id] = item;
  } else {
    for (const [id, item] of Object.entries(data.items)) itemsById[Number(id)] = item;
  }

  return {
    itemsByName: data.itemsByName,
    itemsById,
    recipesByResultId: data.recipes,
  };
}

export function resolveCraftingDependencies(
  knowledge: RecipeKnowledge,
  itemName: string,
  count = 1,
  inventory: InventoryCounts = {},
): DependencyPlan {
  const target = findItem(knowledge, itemName);
  if (!target) {
    return {
      target: itemName,
      count,
      canCraftFromInventory: false,
      missingBaseItems: [],
      craftingSteps: [],
      errors: [`Unknown item: ${itemName}`],
    };
  }

  const remainingInventory: InventoryCounts = { ...inventory };
  const missing = new Map<string, number>();
  const steps: DependencyStep[] = [];
  const errors: string[] = [];

  const resolve = (item: RecipeItem, neededCount: number, stack: string[]): void => {
    if (neededCount <= 0) return;

    const available = remainingInventory[item.name] ?? 0;
    const consumed = Math.min(available, neededCount);
    if (consumed > 0) {
      remainingInventory[item.name] = available - consumed;
      neededCount -= consumed;
    }
    if (neededCount <= 0) return;

    if (stack.includes(item.name)) {
      errors.push(`Recipe cycle detected: ${[...stack, item.name].join(' -> ')}`);
      addCount(missing, item.name, neededCount);
      return;
    }

    const recipe = chooseRecipe(knowledge, item.id, remainingInventory);
    if (!recipe) {
      addCount(missing, item.name, neededCount);
      return;
    }

    const resultCount = Math.max(1, recipe.result?.count ?? 1);
    const crafts = Math.ceil(neededCount / resultCount);
    const ingredients = getRecipeIngredients(knowledge, recipe, crafts);

    for (const ingredient of ingredients) {
      resolve(ingredient.item, ingredient.count, [...stack, item.name]);
    }

    const produced = crafts * resultCount;
    const surplus = produced - neededCount;
    if (surplus > 0) {
      remainingInventory[item.name] = (remainingInventory[item.name] ?? 0) + surplus;
    }

    upsertStep(steps, {
      output: item.name,
      count: produced,
      crafts,
      ingredients: ingredients.map(ingredient => ({
        name: ingredient.item.name,
        count: ingredient.count,
      })),
      requiresTable: recipeRequiresTable(recipe),
    });
  };

  resolve(target, Math.max(1, Math.ceil(count)), []);

  return {
    target: target.name,
    count: Math.max(1, Math.ceil(count)),
    canCraftFromInventory: missing.size === 0 && errors.length === 0,
    missingBaseItems: [...missing.entries()].map(([name, missingCount]) => ({ name, count: missingCount })),
    craftingSteps: steps,
    errors,
  };
}

export function summarizeDependencyPlan(plan: DependencyPlan): string {
  const missing = plan.missingBaseItems.length
    ? plan.missingBaseItems.map(item => `${item.name}x${item.count}`).join(', ')
    : 'none';
  const steps = plan.craftingSteps.length
    ? plan.craftingSteps.map(step => `craft ${step.output}x${step.count}`).join(' -> ')
    : 'none';
  const errors = plan.errors.length ? ` | errors=${plan.errors.join('; ')}` : '';

  return [
    `target=${plan.target}x${plan.count}`,
    `can_craft_from_inventory=${plan.canCraftFromInventory}`,
    `missing_base=${missing}`,
    `steps=${steps}`,
  ].join(' | ') + errors;
}

function findItem(knowledge: RecipeKnowledge, itemName: string): RecipeItem | undefined {
  return knowledge.itemsByName[itemName]
    ?? Object.values(knowledge.itemsByName).find(item => item.name.includes(itemName));
}

function chooseRecipe(knowledge: RecipeKnowledge, itemId: number, inventory: InventoryCounts): Recipe | undefined {
  const recipes = knowledge.recipesByResultId[itemId] ?? [];
  return recipes
    .map(recipe => ({ recipe, score: scoreRecipeAgainstInventory(knowledge, recipe, inventory) }))
    .sort((a, b) => b.score - a.score)[0]?.recipe;
}

function getRecipeIngredients(
  knowledge: RecipeKnowledge,
  recipe: Recipe,
  crafts: number,
): Array<{ item: RecipeItem; count: number }> {
  const counts = new Map<number, number>();
  const ids = recipe.ingredients
    ?? recipe.inShape?.flat()
    ?? [];

  for (const id of ids) {
    if (id == null) continue;
    addCount(counts, id, crafts);
  }

  return [...counts.entries()].flatMap(([id, ingredientCount]) => {
    const item = knowledge.itemsById[id];
    return item ? [{ item, count: ingredientCount }] : [];
  });
}

function recipeRequiresTable(recipe: Recipe): boolean {
  if (typeof recipe.requiresTable === 'boolean') return recipe.requiresTable;
  const height = recipe.inShape?.length ?? 0;
  const width = recipe.inShape?.reduce((max, row) => Math.max(max, row.length), 0) ?? 0;
  return height > 2 || width > 2;
}

function addCount<T>(map: Map<T, number>, key: T, count: number): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function scoreRecipeAgainstInventory(
  knowledge: RecipeKnowledge,
  recipe: Recipe,
  inventory: InventoryCounts,
): number {
  return getRecipeIngredients(knowledge, recipe, 1).reduce((score, ingredient) => {
    return score + Math.min(inventory[ingredient.item.name] ?? 0, ingredient.count);
  }, 0);
}

function upsertStep(steps: DependencyStep[], next: DependencyStep): void {
  const existing = steps.find(step => step.output === next.output);
  if (!existing) {
    steps.push(next);
    return;
  }

  existing.count += next.count;
  existing.crafts += next.crafts;
  existing.requiresTable = existing.requiresTable || next.requiresTable;
  const ingredientCounts = new Map(existing.ingredients.map(item => [item.name, item.count]));
  for (const ingredient of next.ingredients) {
    ingredientCounts.set(ingredient.name, (ingredientCounts.get(ingredient.name) ?? 0) + ingredient.count);
  }
  existing.ingredients = [...ingredientCounts.entries()].map(([name, count]) => ({ name, count }));
}
