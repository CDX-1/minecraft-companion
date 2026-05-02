import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecipeKnowledge,
  createRecipeKnowledge,
  resolveCraftingDependencies,
  summarizeDependencyPlan,
} from './DependencyResolver';

const knowledge: RecipeKnowledge = createRecipeKnowledge({
  itemsByName: {
    oak_log: { id: 1, name: 'oak_log' },
    oak_planks: { id: 2, name: 'oak_planks' },
    stick: { id: 3, name: 'stick' },
    crafting_table: { id: 4, name: 'crafting_table' },
    wooden_pickaxe: { id: 5, name: 'wooden_pickaxe' },
    birch_planks: { id: 6, name: 'birch_planks' },
  },
  items: {
    1: { id: 1, name: 'oak_log' },
    2: { id: 2, name: 'oak_planks' },
    3: { id: 3, name: 'stick' },
    4: { id: 4, name: 'crafting_table' },
    5: { id: 5, name: 'wooden_pickaxe' },
    6: { id: 6, name: 'birch_planks' },
  },
  recipes: {
    2: [{ ingredients: [1], result: { id: 2, count: 4 } }],
    3: [
      { inShape: [[2], [2]], result: { id: 3, count: 4 } },
      { inShape: [[6], [6]], result: { id: 3, count: 4 } },
    ],
    4: [{ inShape: [[2, 2], [2, 2]], result: { id: 4, count: 1 } }],
    5: [
      { inShape: [[2, 2, 2], [null, 3, null], [null, 3, null]], result: { id: 5, count: 1 } },
      { inShape: [[6, 6, 6], [null, 3, null], [null, 3, null]], result: { id: 5, count: 1 } },
    ],
  },
});

test('resolves wooden pickaxe dependencies recursively to gatherable logs', () => {
  const plan = resolveCraftingDependencies(knowledge, 'wooden_pickaxe', 1, {});

  assert.equal(plan.canCraftFromInventory, false);
  assert.deepEqual(plan.missingBaseItems, [{ name: 'oak_log', count: 2 }]);
  assert.deepEqual(plan.craftingSteps.map(step => `${step.output}x${step.crafts}`), [
    'oak_planksx2',
    'stickx1',
    'wooden_pickaxex1',
  ]);
});

test('uses inventory counts before adding base requirements', () => {
  const plan = resolveCraftingDependencies(knowledge, 'wooden_pickaxe', 1, {
    oak_planks: 3,
    stick: 2,
  });

  assert.deepEqual(plan.missingBaseItems, []);
  assert.equal(plan.canCraftFromInventory, true);
  assert.deepEqual(plan.craftingSteps.map(step => step.output), ['wooden_pickaxe']);
});

test('summarizes recursive dependency plan for tool feedback', () => {
  const plan = resolveCraftingDependencies(knowledge, 'wooden_pickaxe', 1, {});

  assert.match(summarizeDependencyPlan(plan), /target=wooden_pickaxex1/);
  assert.match(summarizeDependencyPlan(plan), /missing_base=oak_logx2/);
  assert.match(summarizeDependencyPlan(plan), /steps=craft oak_planks/);
});

test('prefers recipe variants that match current inventory', () => {
  const plan = resolveCraftingDependencies(knowledge, 'wooden_pickaxe', 1, {
    birch_planks: 5,
  });

  assert.deepEqual(plan.missingBaseItems, []);
  assert.equal(plan.canCraftFromInventory, true);
  assert.deepEqual(plan.craftingSteps.map(step => step.ingredients.map(item => item.name)), [
    ['birch_planks'],
    ['birch_planks', 'stick'],
  ]);
});
