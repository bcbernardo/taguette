# Highlight System

SVG overlay approach — the HTML document stays intact, highlights are drawn as lines on top.

## How it works

1. **loader.js** fetches the document and builds two layers: a content div (text) and an SVG element (highlights)
2. **renderer.js** converts UTF-8 byte offsets to DOM positions using a char map, then uses `Range.getClientRects()` to get pixel coordinates for each highlight
3. Only block elements (`<p>`, `<h1>`-`<h6>`, etc.) that contain highlights get extra line-height — the rest stays normal
4. Overlapping highlights are stacked in lanes so they don't collide
5. Multi-tag highlights use SVG gradients
6. **crud.js** handles create/edit/delete via the API

## Files

- `renderer.js` — rendering pipeline, smart lanes, tooltips
- `loader.js` — document loading, ResizeObserver
- `crud.js` — CRUD operations
