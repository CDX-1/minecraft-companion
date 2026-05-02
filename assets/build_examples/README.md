# Build Examples

Reference library the AI consults before generating a structure. Each `.json` file describes one hand-picked build (style, palette, dimensions, vibe). The AI reads the catalog (`listExamples`), pulls 1-3 close matches (`getExamples`), and uses them to inform the parametric `build_design` call — it does NOT replay these blocks directly.

## Schema

```json
{
  "id": "unique_slug",
  "name": "Human-readable name",
  "structureType": "tower | house | castle | ...",   // closest match in src/services/blueprints.ts StructureType
  "tags": ["medieval", "stone", "fortified"],         // free-form vibe descriptors for retrieval
  "description": "1-3 sentence prose description of the look and feel",
  "palette": {
    "primary": "minecraft:stone_bricks",
    "accent": "minecraft:dark_oak_log",
    "glass": "minecraft:glass_pane",
    "decoration": ["minecraft:lantern", "minecraft:oak_door"]
  },
  "dimensions": { "width": 9, "depth": 9, "height": 14 },
  "params": { "radius": 4, "height": 14, "floors": 3 },  // suggested params for build_design
  "source": "manual | https://example.com/build-link",
  "notes": "Optional implementation tips for the AI"
}
```

## Adding examples

1. Drop a new `.json` file in this directory.
2. Pick a `structureType` that matches one of the parametric generators.
3. Populate `palette` with full `minecraft:` block IDs.
4. Set `params` so calling `build_design` with those params produces something close to the vibe.

## Future migration

Schema is designed to drop into Supabase: `id` is the primary key, `description` + `tags` will get embedded for pgvector retrieval, and the file itself becomes a row.
