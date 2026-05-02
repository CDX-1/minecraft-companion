# Litematic files

Drop `.litematic` files here and reference them from a sibling JSON in the parent folder.

## How to add a new example with a litematic

1. Find/build the structure in Minecraft. Save it with the [Litematica mod](https://www.curseforge.com/minecraft/mc-mods/litematica) → `Save schematic to file`.
2. Copy the resulting `.litematic` into this folder. Example: `gothic_cathedral.litematic`.
3. Create a JSON file in the parent folder (`assets/build_examples/`) with the metadata. Use `medieval_stone_tower.json` as a template. Add a `litematic` field pointing to the filename:

```json
{
  "id": "gothic_cathedral",
  "name": "Gothic Cathedral",
  "structureType": "house",
  "tags": ["gothic", "cathedral", "stone", "vaulted", "religious", "tall"],
  "description": "...",
  "palette": {
    "primary": "minecraft:stone_bricks",
    "accent": "minecraft:dark_oak_log",
    "glass": "minecraft:white_stained_glass_pane"
  },
  "params": { "width": 15, "depth": 25, "height": 20 },
  "litematic": "gothic_cathedral.litematic"
}
```

4. Pick a `structureType` from the parametric list in `src/services/blueprints.ts`. The closer the parametric generator can get to the build, the better — the AI uses it as the construction recipe.
5. Restart the bot. On startup, the parser extracts statistics (block-frequency histogram, true dimensions, vertical layer breakdown) and feeds them into the AI's reference card alongside your hand-written `description` and `palette`.

## What the parser extracts

- **Real dimensions** — bounding box across all regions in the litematic.
- **Block mix** — top 12 blocks by count, with percentage of non-air blocks. The AI uses this to override the hand-written palette if the real distribution disagrees.
- **Vertical layers** — top blocks at the floor third, mid third, and roof third. Tells the AI things like "the roof is 80% dark_oak_log."
- **Total non-air blocks** and **unique block types**.

## What is NOT used

- Block rotation / orientation states (the parametric generators handle facing themselves).
- Entities, tile entities, NBT data on individual blocks (no item frames, no chest contents).
- The actual block layout — we're treating the litematic as a *statistical reference*, not playback. The AI still calls the parametric `build_design` to construct.

## Tips

- **Multi-region litematics work.** The parser aggregates stats across all regions.
- **If parsing fails**, the JSON metadata is still used — the AI just won't see the extra stats. The error is logged to `litematicError`.
- **Big files are fine.** Parsing is one-shot at startup; runtime cost is zero.
- **Sources:** Litematic-friendly sites include the [Litematica subreddit](https://www.reddit.com/r/litematica/), [planetminecraft](https://www.planetminecraft.com/) (filter for litematic), and [LitematicShare](https://litematic.com/).
