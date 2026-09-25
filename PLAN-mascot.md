# PLAN — welcome header + animated mascot at Claude Code 2.1.282 fidelity

Goal: make bluclawd's startup welcome match Claude Code 2.1.282. Give the mascot Claude Code's
entrance animation, and draw it with exactly the proportions of `ext/branding/mascot.svg`, in
both the welcome header and the agent view.

(Kept apart from `PLAN.md`, which holds another session's unstarted background-bash plan.)

**Evidence.** Citations like `m1356:1299` point into the 2.1.282 bundle split into modules and
pretty-printed. The split is at `$CLAUDE_JOB_DIR/tmp/cc/pp/` (job 8994e1de). To rebuild it:
1. Cut `~/.local/share/claude/versions/2.1.282` from byte 173,513,384 to EOF.
2. Split on `// @bun @bytecode`.
3. Truncate each part at its first NUL.
4. Run `npx esbuild --format=esm`.

Quote the code itself before changing a string.

**Verification.**
- Every task: `npx vitest run <touched tests>`, `npm run typecheck`, `npm run lint`.
- The welcome and agent view also need a live tmux verify. `quietStartup` hides the banner, so
  use a fake HOME (or `--verbose`) and `tmux new -x 120 -y 45`. Read the result with
  `capture-pane -p -e` and parse the `38;2` / `48;2` codes. For the animation, capture several
  frames about 60 ms apart.
- Before each edit, re-check `git status` and mtimes: another session shares this tree.

## What Claude Code 2.1.282 actually does

**Welcome** (`m1356` `_s`, lines 1292–1360). There is no box, no two panes, no
"Welcome back", and no Tips / Recent activity / What's new columns. None of those strings
exist in 2.1.280–2.1.282.

Layout: `row, gap 2, alignItems center` → `[Clawd 9×3] [column of 3 lines]`:
1. bold `Claude Code`, then a space and dim `v2.1.282`, in the default text color.
2. dim `<model>[ with <effort> effort] · <billing>`. It splits onto two lines when
   `len(model)+3+len(billing) > width`.
3. dim cwd, `~`-abbreviated and elided as `first/…/tail` (`m0713:305`), with
   `width = max(cols-15, 20)`.

**Clawd** (`m0722`). 9×3 cells of quadrant blocks, body `#D77757` on bg `#000000`.
- Poses: `default`, `look-left`, `look-right`, `arms-up`.
- The eyes move by swapping glyphs.
- Apple Terminal gets its own variant.

**Animation** (`m1353` `tne`).
- Every frame lasts 60 ms, and each sequence plays once.
- Frame fields:
  - `offset` is a `marginTop` crouch; the feet are clipped.
  - `x` is a `marginLeft` slide.
  - `poof` draws dim `·` then `~` on the feet row.
- Sequences:

  | Sequence | Frames |
  |---|---|
  | `jump` | 12 |
  | `look` | 11 |
  | `spin` | 10 |
  | `skip` | 14 |
  | `celebrate` | 15 |

**Triggers.**
- The entrance plays only in fullscreen TUI mode (`m1356:1299`).
- It plays once per version: when `lastClawdEntranceVersion` is older than the current
  version, one of skip/jump/look/spin is picked at random (`m1353:120`).
- `CLAUDE_CODE_FORCE_FIRST_LAUNCH` forces it.
- Clicking plays `jump` or `look`.
- `prefersReducedMotion` (settings key, "Reduce motion" in /config) disables it, as does a
  screen reader.
- The inline renderer always draws Clawd static.

**Agent view** (`m0727:2560`). The same static Clawd, shown only when `!compactHeader &&
columns >= 70`, in `row gap 2, marginBottom 1` next to 3 text lines. It is never animated.

## What bluclawd has today

- `ext/branding/welcome-box.ts` draws a rounded two-pane box, and `welcome-info.ts` fills its
  sidebar with Model / Loaded / Recent sessions / Tips (powerline port, commit 986e4bf). That is
  an older Claude Code design.
- The mascot is `mascot.png`, decoded at runtime with photon as 22×8 half-blocks (widened by
  doubling columns 2 and 17).
- The agent view has a hand-drawn 10×3 quarter-block `MASCOT` (`agent-view.ts:172`). Its aspect
  is about 1.46:1 against the source's 1.33:1, and the bands are squashed. The proportions are
  wrong.

## Facts that constrain the design

- **`mascot.svg` has no vector parts.** It embeds two copies of the same 2000×1500 raster: an
  RGB image and a grayscale luminance mask. The pixels are identical to `mascot.png`. There are
  no layers or groups to animate, so every frame has to be written as an edit of the pixel
  grid. The SVG becomes the canonical source of that grid.
- **The source grid is 20×15** (100 px blocks) and admits no smaller exact version:
  ```
  row 0-1   ........####........   dome
  row 2-3   ....############....   head
  row 4-5   ..###oo######oo###..   eyes (o = #1e1e1e)
  row 6-8   ####################   arms + body
  row 9-11  ..################..   body
  row 12-14 ...##.##....##.##...   legs
  ```
  The band heights are 2/2/2/3/3/3, so no 3-line render keeps them. Claude Code's exact 9×3
  footprint is impossible without distorting the parts.
- **A half-block and an octant (U+1CD00–1CDE5, 2×4 per cell) have the same 0.875 pixel aspect**
  in a 14×32 cell. The octant render is therefore the same exact-proportion image at half the
  size: 22×15 px → **11 cols × 4 lines**, against 22×8 for half-blocks. The 16th pixel row is a
  spare pad row.
  - Checked: pi-tui's `visibleWidth` reports 1 for U+1CD00, U+1CDE5 and U+1FB00, so layout
    holds.
  - Not yet checked: that Ghostty (the user's terminal) draws octants.
  - An octant cell has only fg + bg, so every cell may hold at most 2 of {body, eye,
    transparent}. The default pose meets this: the eyes land exactly on cell pairs after
    widening.
- pi-tui gives components no mouse events, so the click trigger cannot be ported.

## Decisions (taken 2026-09-25: the recommended option for each; D2 octant after Tier 0 passed)

- [x] **D1: welcome layout.** For Claude Code parity, replace the box and sidebar with Claude
  Code's unboxed header: mascot + 3 lines.
  - This **removes** the Model / Loaded / Recent sessions / Tips sidebar approved in the
    powerline port, and deletes `welcome-box.ts` and `welcome-info.ts` with their tests.
  - **Recommended: remove** (parity).
  - Alternative: keep the sidebar as a deliberate deviation.
- [x] **D2: mascot glyphs.**
  - **A (recommended): octant 11×4 everywhere.** Fall back to half-block 22×8 on terminals known
    to lack octants: `TERM_PROGRAM=Apple_Terminal`, `TERM=linux`. This mirrors Claude Code's
    own Apple_Terminal branch.
  - B: half-block 22×8 everywhere. It works on any terminal, but it is 8 lines tall and makes a
    big welcome and agent-view header.
  - A is gated on the Tier 0 visual check.
- [x] **D3: `mascot.png`.** The grid becomes a committed constant, checked against
  `mascot.svg` by a test, and the runtime photon decode goes away.
  - **Recommended: delete `mascot.png`** and keep `mascot.svg` as the only source.
  - Alternative: keep both.
- [x] **D4: animated SVG file.** The frame table could also emit
  `ext/branding/mascot-animated.svg` (CSS keyframes, one `<rect>` per pixel) for the README.
  - Recommended: **skip.** It was not asked for directly, and the Tier 1 preview already lets
    you review the motion.
- [x] **D5: commits.** One commit per tier after tests + live verify, as in earlier plans?
  Pushes still ask.

## Tier 0: gate

- [x] **0.1 Octant render check.**
  - Write a file with the default pose in octants and in half-blocks.
  - The user runs `cat` on it in Ghostty (inside tmux, as they normally work) and confirms the
    octants are solid blocks, not tofu (missing-glyph boxes).
  - verify: user's answer. If octants fail, D2 falls to B.

## Tier 1: mascot model + frames (no UI yet)

- [x] **1.1 `ext/branding/mascot.ts`: the grid.**
  - The 20×15 grid above as a string constant.
  - A test decodes both PNGs embedded in `mascot.svg` with photon (the color image, alpha =
    mask luminance), samples them at 100 px, and asserts equality with the constant.
  - verify: the test fails if one pixel of the constant is changed.
- [x] **1.2 Poses as grid edits.** Every pose moves parts and never resizes them.
  - `default`: the source.
  - `look-left` / `look-right`: both 2×2 eyes shift one column (to 4-5 / 12-13, or 6-7 / 14-15).
  - `arms-up`: the arm pixels (cols 0-1 and 18-19) move from rows 6-8 to rows 5-7.
  - Tests:
    - For every pose, each connected part keeps its source size: eyes 2×2, legs 2×3, arms
      2×3, dome 4×2, head 12×2, body bands.
    - Doubled columns 2 and 17 stay flat in every row, so widening changes no part.
    - Every octant cell holds ≤2 values.
- [x] **1.3 Sequences.** Port `jump`, `look`, `spin` and `skip` frame for frame (`m1353:33-46`):
  60 ms per frame, plus 2 hold frames (`delayMs:100`).
  - `offset:1` (crouch) becomes a one-pixel drop into the spare pad row. Nothing is clipped,
    so the legs keep their length. This is a deliberate deviation: clipping would shorten the
    legs, and the proportions must not change.
  - `x` becomes a slide in cells, scaled to the mascot's width (−11, −7, −4, 0 for 11 cols).
  - `poof` draws dim `·` then `~` in the gap between the legs, where Claude Code centers it.
  - verify: unit tests over the frame table (lengths, durations, last frame = default).
- [x] **1.4 Renderer.** `renderMascot(frame, glyphs: "octant" | "halfblock")` returns ANSI
  lines.
  - Half-block reuses `encodeHalfBlockRows`.
  - The octant encoder maps each 2×4 cell to its U+1CD00-block glyph. Patterns that Unicode
    already covers elsewhere (space, `▘▝▀▖▌▞▛▗▚▐▜▄▙▟█`, `▔▁`) use those code points.
  - verify: a snapshot of the default pose in both encodings, plus a
    decode-back-to-pixels round-trip test.
- [x] **1.5 Motion preview for approval.**
  - Publish a private HTML artifact that plays every sequence at 60 ms, drawn with 14×32 px
    cell proportions, next to the static source.
  - verify: the user approves the motion before Tier 2.
  - Done differently: the user asked to run the whole plan without stopping, so the motion
    was checked with a live tmux frame capture instead. Replay it with
    `BLUCLAWD_FORCE_FIRST_LAUNCH=1 pi`.

## Tier 2: welcome header (Claude Code `_s`)

- [x] **2.1 Replace `WelcomeBox`** (if D1 = remove) with a header component laid out like
  Claude Code's:
  - A row: mascot, then a gap of 2, then 3 lines, centered vertically on the mascot's height.
    The text sits on rows 0-2 or 1-2 of a 4-line mascot; pick by the live check against
    Claude Code's centering.
  - Line 1: bold `bluclawd` + dim `v<version>`, in the default text color (not accent).
  - Line 2: dim `<model name>[ with <thinking level> effort] · <provider display name>`.
    - The effort part shows only for reasoning models with thinking ≠ off.
    - The provider stands in for Claude Code's billing field, which keeps it
      provider-neutral.
    - The two-line split follows `_Xn`.
  - Line 3: dim cwd, `~`-abbreviated, elided as `first/…/tail` at `max(cols-15, 20)`.
  - Delete `welcome-box.ts`, `welcome-info.ts` and `test/branding-welcome-info.test.ts`, and the
    `recentSessions` / `loadProjectContextFiles` code in `branding/index.ts`.
  - verify: unit tests for the text lines and the elide; tmux capture at 120, 80 and 50 cols.
- [x] **2.2 Entrance animation.**
  - A `setTimeout` chain drives `tui.requestRender()`, and the timer is cleared in
    `dispose()` (pi calls `customHeader.dispose` on replacement).
  - Plays only when all of these hold:
    - `SettingsManager.getTuiMode() === "fullscreen"`.
    - `prefersReducedMotion` is not true (read through `_shared/settings.ts`).
    - `lastMascotEntranceVersion` is older than the version the header shows (pi's
      `VERSION`, as Claude Code gates on its own shown version), or
      `BLUCLAWD_FORCE_FIRST_LAUNCH` is set.
  - The version is stored in `<agentDir>/branding-prefs.json`, following the `agent-view/prefs.ts`
    pattern, and saved when the entrance starts.
  - One of skip/jump/look/spin is picked at random. Otherwise the mascot is static.
  - verify: tests with fake timers (plays once, stops, reduced motion, inline mode, version
    gate, dispose clears the timer). Then a tmux live capture of frames with
    `BLUCLAWD_FORCE_FIRST_LAUNCH=1`, and a second launch that stays static.

## Tier 3: agent view

- [x] **3.1 Replace `MASCOT`** in `agent-view.ts` with the shared static `default` pose from
  `renderMascot`, keeping the mascot's color.
  - Show it only when `columns >= 70` (Claude Code's rule); without it the text shifts left.
  - A 4-line mascot beside 3 text lines leaves the 4th text row empty.
  - Update `test/agent-view.test.ts:435`.
  - verify: tests, plus a tmux capture of `/agent-view` at 120 and 60 cols.

## Deliberate deviations (stay after this plan)

- Mascot footprint: 11×4 octants (or 22×8 half-blocks), not 9×3. The exact proportions of
  `mascot.svg` require it.
- ~~Crouch drops by one pixel instead of clipping the feet.~~ Reversed 2026-09-25 at the user's request ("as close to Claude Code as possible"): the crouch drops one octant row and the feet leave the box, as in Claude Code. Look moves the eyes a full eye width and arms-up raises the arms 3 rows, Claude Code's moves scaled to the 20×15 grid. Claude Code's eyes also rise 1 px when looking; that would need 3 colors in one octant cell, so it is left out.
- No click trigger: pi-tui has no mouse events for components. A click was built once (f257848) by reordering pi-tui's private input listeners, then reverted at the user's request to stay on pi's public API; no keyboard replacement wanted.
- No screen-reader hide: pi exposes no screen-reader signal.
- No update-summary line under the header ("Updated to latest…"), no announcement slot, no
  `@agentName` prefix: pi has no counterpart.
- Mascot colors stay bluclawd's: cyan `#00c0e8` body, `#1e1e1e` eyes (the SVG's values).
