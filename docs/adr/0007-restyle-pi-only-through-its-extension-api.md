# bluclawd restyles pi only through its extension API and themes

bluclawd changes how a pi session looks in the terminal only through pi's public extension API (`registerToolRenderer`, `setWorkingMessage`, `setHeader`, editor factories) and its own themes, never by patching, forking or importing pi's internals. Every renderer it adds wraps pi's own: anything it does not recognise, and every expanded tool view, falls through to pi's renderer via `next()`. bluclawd is an extension pack on a stock pi that updates on its own schedule, so a pi update must bring its new rendering with it rather than break or hide behind bluclawd's.

Decided 2026-11-06, while grilling a Claude Code–style terminal look.

## Considered Options

- **Fork or patch pi's interactive components**: rejected. It would freeze bluclawd to one pi version.
- **Re-implement pi's built-in tool renderers**: rejected. Collapsed views are bluclawd's; expanded views stay pi's, so a pi fix or new tool field reaches the user unchanged.

## Consequences

- What the API cannot reach stays pi's: spacing between transcript items, the user and assistant message components, and the editor's border shape (only `protected` methods would allow it).
- The footer belongs to the separate pistatusline package, not to bluclawd.
