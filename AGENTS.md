# Repository instructions

## Use the knowledge graph first

This repo has a graphify knowledge graph at `graphify-out/graph.json` (interactive view: `graphify-out/graph.html`, report: `graphify-out/GRAPH_REPORT.md`).

Before reading files to locate code for any task, use the graph to find the relevant bits:

```bash
graphify query "<what are you looking for>"          # broad context (BFS)
graphify query "<question>" --dfs                    # trace a specific path
graphify path "<Node A>" "<Node B>"                  # shortest path between concepts
graphify explain "<node name>"                       # plain-language explanation of a node
```

Then read only the files and locations the graph points to — not whole directories.

Guidance:

- If `graphify query` is unavailable, fall back to traversing `graphify-out/graph.json` directly (it is standard JSON: nodes, edges, communities) with `python` + `networkx`/`jq`.
- Cite `source_file` / `source_location` from graph nodes when they identify the code to touch.
- The graph may lag behind recent edits. If code you find via the graph contradicts what is on disk, trust the disk, and refresh with `graphify --update` if the drift seems broad.
- Never invent edges or nodes; answer only from what the graph contains.
