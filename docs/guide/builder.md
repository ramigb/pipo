# Builder

The builder is the dashboard's visual editor for `.pipo` files (`#/build`). You drag blocks onto a canvas, wire them together and fill them in with forms, and it saves an ordinary `.pipo` file. **The file stays the source of truth.** What the builder writes is what you'd write by hand, comments you wrote are kept, and anything you can build here you can also edit in your editor, and the other way round.

```sh
pipo ui        # then 🛠️ Builder, or ✨ New pipeline on the home page
```

You can also open a running pipeline's file from its page with **✏️ Edit**, or any workspace file from **🧰 Ready to run**.

## Layout

| Area | What's there |
|---|---|
| **Palette** (left) | The blocks you can add, from the connector catalog. |
| **Canvas** (middle) | The pipeline as blocks and wires, or as a town (**🔀 Graph \| 🏙️ City**). Zoom, fit to screen, and **Tidy up** (auto-layout). |
| **Side panel** (right) | **🔧 Inspect** (the selected block's form), **📜 YAML** (the file the canvas makes), **🧪 Test** (dry runs) and **⚠️** (problems, with their count). |
| **Top bar** | **📂 Open a pipeline**, **✨ New**, undo and redo, **💾 Save**, **▶️ Save & run** and, for a running pipeline, **🚀 Apply live**. |

## Adding and wiring blocks

The palette has three groups:

- **📥 Inputs**: `http`, `schedule`, `watch`, `push`, `system`, `telegram` and `pipeline`.
- **🪄 Steps**: `map`, `http call`, `run program` (exec), `filter`, `route`, a tap for each tap connector (`log`, `http`, `file`, `telegram`, `emit`, `exec`), and **🤖 Agents**, a row that folds open in place with Claude API, Claude Code, Codex, pi and opencode.
- **📤 Outputs**: `sqlite`, `file`, `http`, `telegram`, `pipeline` and `stdout`.

Drag a block onto the canvas, or click it:

- A new step slots in **after the selected block**, or before the output when nothing is selected, and takes over what was fed there.
- Dropping an input or an output **swaps** the pipeline's one, since a pipeline has exactly one output. Dropping another input adds a second input (see [Inputs](inputs.md#several-inputs)).
- **Wire** blocks by dragging from an out-port (●) onto another block. A route has one out-port per branch.
- **Delete** (or Backspace) removes the selected block or wire. Removing a block wires its parents straight to what it fed.
- **Undo** (Ctrl+Z) and **redo** (Ctrl+Shift+Z) cover every edit.

`fn.<name>` steps are chosen in a transform's or tap's inspector (**🧩 my own function**), once the pipeline's `fn:` module is set.

## The inspector

Select a block to edit it in **🔧 Inspect**. Each connector's `with:` form is generated from its JSON Schema, so it always offers exactly the settings `pipo check` accepts. Select nothing to edit the pipeline itself (**📋 Pipeline**): its name, description, `fn` module, concurrency, secret references (**🔐 Secrets**), default error policy and **🤖 Agent budget**. Anything the forms don't cover can be written in the file directly; the builder keeps it.

### 📦 Data samples

Every block's inspector shows **📦 data**: an example of `data` as it reaches the block (as it leaves, for an input). Click a path in it to put it into the field you last used, as `${data.x}` in a template or `data.x` in an expression.

The examples come from what the builder knows:

- the input's `schema` file (an example generated from it), else the input connector's built-in sample (`watch`, `system`, `telegram`), else a `schedule`'s `payload`;
- taps, filters and routes pass the shape on; `map` renders its template against it; an agent node gives an example of its schema file;
- `fn` and `http` transforms make the shape unknown. A **🧪 test run** shows the real data.

The samples are only hints: `pipo check` never checks a template against them.

### Agent blocks

An agent that can't run on this machine (not installed, not logged in, no API key) is greyed out in the palette with **⚠️**. Clicking it says why and what to do instead of adding it, and an agent block that uses it shows the same in its inspector, with **🔄 check again**. The builder asks the engine which agents are ready, and caches the answer for 5 minutes.

- Changing an agent block's provider keeps the settings the new provider also takes (prompt, schema, timeout) and drops the others.
- The model field suggests the provider's models but takes any text. A new Claude Code block starts on `sonnet`, a Codex block on Codex's first listed model, and pi and opencode on their own default.
- The inspector edits the agent's schema file in place, as the "answer shape" (**💾 Save schema**). The dry run's stub for the agent is generated from it.

See [Agent nodes](agent-nodes.md).

## Live check and quick fixes

Every edit runs through `pipo check` on the engine. Problems show as badges on their block and in the **⚠️** tab, with the same message and hint the CLI gives. Some come with a one-click fix:

- A schema file that the pipeline names but that doesn't exist (P014 on an agent's `with.schema` or the input's `schema`) is created with a starter schema.
- An agent node without a cost cap (P053) gets `agent_budget: {per_day: 1}`.

A draft with errors can still be saved: it's a draft, and `pipo start` refuses it with the same diagnostics until you fix it.

## 🧪 Test: dry runs

The **🧪 Test** tab sends a packet through the draft **in memory**. Nothing is called, sent or written: taps and the output only show what they would do, agent nodes and `transform: http` answer from stubs, and the real clock is used. It runs exactly what `pipo test` runs (see [Testing](testing.md)).

- It starts on the file's first fixture from its `fixtures/` folder. Pick another fixture, or edit the data. A picked fixture runs with its own `meta` and `stubs` unless you edit its data.
- **🧪 Dry run** runs one packet, and **▶️ Run all** runs every fixture.
- The canvas lights up the path the packet took, and the panel shows the data leaving every step. In the city view, a packet van drives along the lanes it took and each building is marked ✅, 💥 or 🫥.
- For a running pipeline, **🛰️ Push a real one** takes you to its page to send a real packet.

## Saving

| Button | Effect |
|---|---|
| **💾 Save** | Writes the `.pipo` file atomically. A new draft is saved as `<workspace>/<name>/<name>.pipo`. |
| **▶️ Save & run** | Saves, then starts the pipeline. |
| **🚀 Apply live** | For a running pipeline: sends the draft as a proposal (`by: ui`), which is checked and applied as a new version for new packets. Once applied, the file is saved too, so the next start runs the same version. A refused proposal leaves the file as it was. See [Versions and rollback](versions.md#live-changes-and-restarts) for what can change live. |

The builder keeps your file's comments and layout: it applies its changes onto the text you opened, and what didn't change stays exactly as it was. A new file is written in `pipo fmt`'s canonical order.

Until a draft is saved, checks, dry runs and schema files resolve relative paths from the file it will be saved as.

### What stays in the browser

Some things belong to your view, not to the pipeline, so they're kept in the browser per file, not in the `.pipo` file:

- **Block positions** and **city lots**.
- **Unsaved edits.** Reopening a file brings them back ("Welcome back! I kept your unsaved changes"), with its saved version one undo away, as long as the file hasn't changed on disk since. If it has, the saved version opens and the old edits are dropped with a note.
- Your choice of Graph or City, and whether the agents row is open.

Work started for one file (a check, a dry run, a save) finishes for that file even if you open another one meanwhile.

## 🏙️ City view

The **🔀 Graph | 🏙️ City** switch shows the same draft as a small isometric town. Both views edit the same pipeline, so they can never disagree.

- Each block is a building whose shape says what it does: the input is a station with a radio mast, a `map` a workshop, `transform: http` an office tower with a dish, `exec` a factory with a chimney, a filter a checkpoint with a gate, a route a roundabout with a signpost per branch, a tap a kiosk, an agent a domed lab, and the output a depot whose look follows `to:`. The connector's emoji is on a sign, with the label above it.
- Each wire is a coloured data lane along the roads, with arrows in the direction packets go. Each route branch has its own colour. Grey roads, houses, parks and cars are scenery and never carry data.
- The pipeline reads left to right.
- Everything the graph does works here: click or drop palette items (on a building to feed from it), drag a building to another lot (onto another building to swap), pull a lane from a ● port onto a building, select a lane and press Delete, undo, tidy up.
- Problems show as a red ring, a 🚧 barrier and a badge on the label.

## The workspace

New pipelines are saved in the engine's **workspace**, and **📂 Open a pipeline** lists the `.pipo` files under it (four folders deep at most, skipping dot folders, `node_modules`, `fixtures`, `__snapshots__` and `target`). Change it on the dashboard's **⚙️ Settings** page, or start the engine with `pipo ui --workspace <dir>`. See [Dashboard](dashboard.md#settings).

The builder can read and write only `.pipo` files inside the workspace, plus the file of any pipeline the engine runs, wherever it is. Schema files it creates must sit in or below the pipeline's folder.
