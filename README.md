# Book Machine OS

A local, private writing program for planning, drafting, revising, tracking, and exporting books.

## Start it

1. Install the LTS version of Node.js if it is not already installed.
2. Double-click `START.bat`.
3. The app opens at `http://localhost:3000`.

No install step is required. The app uses only Node's built-in modules.

## Desktop app

The app can also run as a desktop shell with Electron.

```bash
npm install
npm run desktop
```

To build a Windows portable executable:

```bash
npm run build:win
```

The desktop shell reads `config/holdfast.env` for `PORT`, `REPO_PATH`, and `DISCORD_WEBHOOK_URL`. In packaged builds, a `config/holdfast.env` file is placed next to the executable so the repo path and webhook can be changed without editing app code.

Optional AI keys can also live in `config/holdfast.env`:

```text
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

## Claude MCP bridge

Holdfast includes MCP support for Claude Code and Claude custom connectors. Keep the desktop app running, then use the values shown in the app's Config tab under **Claude MCP Bridge**.

For Claude's custom connector screen, use the remote MCP URL through a private HTTPS tunnel or domain:

```text
https://holdfast.your-domain.com/mcp
```

If you set an MCP auth token in the Config tab, append it to the connector URL unless the client can send a Bearer token:

```text
https://holdfast.your-domain.com/mcp?token=YOUR_TOKEN
```

Leave OAuth fields blank. The MCP token is separate from the website login.

For Claude Code or MCP clients that launch local servers, use the local config snippet instead.

The server command is:

```bash
node mcp-server.js
```

The MCP bridge talks to the running Holdfast API through `HOLDFAST_URL`, usually:

```text
http://127.0.0.1:3217
```

## Website login and domain access

The desktop app still opens normally on `localhost`. When the same server is reached through a tunnel or custom domain, Holdfast can require a private website login.

In the Config tab:

- Set **Website Login Email** to your email address.
- Set **Replace Website Password** to the password you want.
- Click **Generate MCP Token**, then **Save Config**.

For a custom domain, point a private tunnel such as Cloudflare Tunnel at:

```text
http://localhost:3217
```

Then open the site at your HTTPS domain and sign in with the email/password you configured. For Claude's custom connector, use the MCP URL with the token:

```text
https://holdfast.your-domain.com/mcp?token=YOUR_TOKEN
```

Available MCP tools:

- `holdfast_health` checks whether the app API is reachable.
- `holdfast_status` returns dashboard state, open flags, pending canon deltas, and run monitor details.
- `holdfast_context` returns curated writing context.
- `holdfast_packet` returns a chapter/session packet.
- `holdfast_open_flags` lists unresolved author decisions.
- `holdfast_pending_canon_deltas` lists canon deltas waiting for review.
- `holdfast_submit_chapter_metadata` submits chapter metadata and canon deltas.
- `holdfast_submit_canon_delta` submits one canon delta.
- `holdfast_review_canon_delta` approves or rejects a delta and writes `sessions/resume.signal` as `delta-id|approved` or `delta-id|rejected`.
- `holdfast_create_project` creates a new project through the app workflow.

## Claude command center

The **Claude** tab is the in-app control surface for drafting work. It has two pieces:

- **Claude Connector** stores the current ngrok/HTTPS URL and builds the MCP connector URL for Claude.
- **Pipeline Control** starts Claude jobs from inside the OS for draft, keep-drafting, self-edit, revise, audit, or metadata repair work.

By default, the app tries to run:

```text
claude -p {prompt}
```

If Claude is installed somewhere else or needs different arguments, set **Claude command** and **Args template** in the Claude tab. The OS starts the job in the selected project folder and captures recent output in **Claude Jobs**.

Useful template variables:

- `{prompt}` inserts the generated instruction text directly.
- `{promptFile}` inserts the path to a generated instruction file under `sessions/`.
- `{projectId}` inserts the selected Holdfast project id.
- `{chapter}` inserts the selected chapter number.

## Where your writing lives

Book Machine OS can scan clean project folders and loose DOCX libraries. Configure those paths inside the app's **Config** tab, or set `REPO_PATH` in `config/holdfast.env` for a project root.

In repo mode, every child folder with a `project.json` file is treated as a book project. Loose DOCX libraries are scanned read-only and grouped by book folder.

The app reads and writes the project folders directly, so changes made in the editor are changes to the git repo files.

If `REPO_PATH` is not set, the app creates a standalone `library` folder next to `server.js`.

Inside it:

- `settings.json` stores the machine name and author name.
- `projects/<project-id>/project.json` stores each book brief and chapter beats.
- `projects/<project-id>/manuscript` stores chapter Markdown files.
- `projects/<project-id>/outlines`, `characters`, and `worldbuilding` store supporting notes.
- `projects/<project-id>/sessions` stores logs and open flags.
- `projects/<project-id>/exports` stores manuscript exports, including merged `.docx` files for outside editing.

To use a standalone writing library somewhere else instead of a repo, remove `REPO_PATH` from `START.bat` and use:

```bat
set HOLDFAST_LIBRARY=C:\Users\you\Documents\Book Machine Library
```

## Daily loop

1. Open the Dashboard to see current word count, draft shape, act progress, current status, next useful move, Claude run activity, chapter health, and open decisions.
2. Use Readiness to see blockers, draft health, bible cleanup status, and returned editor passes.
3. Use Pipeline to start planned chapters and move chapters through Drafting, Self-edit, Review, and Final.
4. Use Editor for document-style self-editing in Markdown. It autosaves shortly after you stop typing.
5. Use Session to record session notes, add flags, and manually import metadata JSON if the automated plugin post ever fails.
6. Use Flags for questions, blockers, and pending high-risk canon approvals.
7. Use Bible to inspect `holdfast_bible.docx`, review canon deltas, and apply handled cleanup items back to the DOCX.
8. Use AI Context to generate project-aware packets or ask an API-backed model for analysis.
9. Use Config to update repo paths, Discord webhook, and Anthropic/OpenAI/OpenRouter API keys.
10. Use Project Settings to refine the premise, soft word guide, chapter count, and chapter beats.
11. Use the Dark/Light button in the top bar to switch themes. The choice is saved on this machine.
11. Use Assemble to create manuscript, review, context, and bible-update exports as Word documents, Markdown, or both.
12. Use Git to inspect repo status, create snapshots, review diagnostics, and commit project changes.
13. Use Export to combine drafted chapters into one merged manuscript as both Markdown and `.docx`.

## Useful details

- Search looks through the active project's manuscript, outline, character, worldbuilding, and session files.
- The app live-refreshes project status every few seconds so Dashboard, Pipeline, Flags, Bible, and Log can pick up repo changes made outside the app. It pauses while you are typing or saving.
- Dashboard's Claude run monitor shows the latest touched chapter, pending canon approvals, open flags, resume-signal status, and recent files changed by outside drafting work.
- Dashboard's Chapter Health panel shows which drafted chapters still need summaries, metadata, or canon approval.
- Dashboard's Next Useful Move prioritizes open flags, pending canon approvals, undrafted chapters, missing summaries/metadata, and finalization in that order.
- New projects are created from the sidebar.
- New chapters use the next planned chapter number and include the stored chapter beat.
- Stage changes are written into each chapter as `STATUS: drafting`, `STATUS: self-edit`, `STATUS: review`, or `STATUS: final`.
- Exports omit the `STATUS:` line from each chapter.
- Bible mode reads a `*bible*.docx` file in the project folder.
- Bible Cleanup Queue extracts `PLACEHOLDER`, `TBD`, and `TODO` entries from the bible and stores triage status/notes in `bible-cleanup.json`.
- Applying handled Bible cleanup items writes note text back into `holdfast_bible.docx` and creates a timestamped DOCX backup first.
- Rule checks are advisory. They scan for extracted banned words, banned constructions, and em/en dashes, but they are not a replacement for a real edit pass.
- Editor includes document-width editing, Markdown formatting helpers, find/replace, preview, current-file rule check, word/character counts, and robust autosave.
- Autosave runs shortly after typing, shows Saving/Saved/Unsaved state with last-saved time, saves before switching views/projects or running exports/session actions, supports Ctrl+S, and warns if you try to close while unsaved work remains.
- Chapter metadata is stored in `chapters.json` at the project root.
- Editor-return logs are stored in `editor-returns.json` at the project root.
- Session notes are saved as timestamped Markdown files in `sessions`.
- Session recording can add session notes, next moves, Discord-backed flags, and canon deltas.
- Import Metadata JSON is kept as a manual fallback. The normal workflow is for the drafting plugin to post metadata directly to the app.
- Metadata import updates `chapters.json`, adds any returned canon deltas to `canon-deltas.json`, and adds any returned flags to the flag queue.
- Compatibility health checks are available at `/health`, `/api/health`, and `/api/dashboard/status` for external tools.
- The metadata import endpoint accepts several payload shapes at `/api/chapter/meta/import`, including top-level metadata fields or nested `content`, `metadata`, `meta`, `data`, or `payload` objects.
- AI Context can generate selected-chapter, project overview, open-loop, bible, and canon-update packets for the active book.
- AI requests run through the local server so Anthropic, OpenAI, and OpenRouter keys stay out of the browser UI.
- OpenRouter models can be loaded dynamically with cost/context labels. Sort by cheapest, popular, longest context, or name, and use the free-only filter when you want to watch spend.
- AI responses can be copied or saved into the project's `sessions` folder.
- Config edits `config/holdfast.env` from inside the app. Secret fields are write-only: leave them blank to keep the current value.
- Changes to API keys and webhook are picked up by new requests. Changes to port or library paths require restarting the desktop app.
- Canon candidates are stored in `canon-deltas.json` at the project root.
- Pending high-risk canon deltas can be approved or rejected from Flags or the Bible delta queue. Approving appends the delta to the target canon file, marks it accepted, and writes `sessions/resume.signal` as `approved:<delta id>`. Rejecting marks it rejected and writes `rejected:<delta id>`.
- Bible Health reports placeholders, unresolved canon deltas, unresolved flags, missing summaries, missing metadata, and whether manuscript/support files are newer than the bible.
- Bible cleanup packets collect unresolved bible placeholders, categories, and Alex notes into a portable LLM brief.
- Assemble writes merged files to `exports`. Modes include Manuscript, Review copy, LLM context, and Bible update.
- Assemble can export Word documents (`.docx`), Markdown (`.md`), or both. The Word export is one whole-document manuscript, not one file per chapter.
- Review exports include chapter text, metadata, rule hits, open flags, and canon deltas.
- Context exports can use summaries/metadata with optional chapter text for LLM work.
- Git shows repo diagnostics, git branch/status, changed files, recent files, Discord/bible health, and project counts.
- Create Snapshot writes a timestamped project zip to `snapshots`, excluding git internals, exports, snapshots, and node modules.
- Commit Changes stages and commits changes inside the active project folder with your commit message.
- Readiness summarizes blockers across flags, canon deltas, bible cleanup, summaries, metadata, editor returns, and chapter finalization.

## Running from the terminal

```bash
node server.js
```

Then open `http://localhost:3000`.
