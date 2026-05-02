import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from './agent';

test('system prompt requires ReAct observations and recipe lookup before crafting', () => {
  const prompt = buildSystemPrompt('friendly', 'Alex', undefined, 'balanced');

  assert.match(prompt, /ReAct LOOP/);
  assert.match(prompt, /Observation -> Thought -> Action -> Feedback/);
  assert.match(prompt, /Use get_recipe and dependency_plan/);
  assert.match(prompt, /Do not rely on memory for Minecraft recipes/);
});
