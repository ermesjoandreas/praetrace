# Codemap — how it looks

This file is binding for every change to `web/`. [CLAUDE.md](CLAUDE.md) says what to
know before touching the code; this says what the result has to look like. When the
two disagree about appearance, this one wins.

The interface is **VS Code Dark Modern** — not "inspired by", the actual values from
`microsoft/vscode/extensions/theme-defaults/themes/dark_modern.json`, checked
against a screenshot of the user's own editor on 2026-09-02. A developer who uses
VS Code should not notice they have switched windows.

---

## The five rules

Everything else in this file is a consequence of these. If a change satisfies all
five it is probably right; if it breaks one it is wrong however good it looks.

1. **Chrome is darker than content.** The menu bar, side bars and status bar are
   `#181818`. The canvas is `#1F1F1F`. Floating things — menus, the palette, the
   group editor — are `#202020`–`#222222`. The differences are one to three percent
   and never more. This is the *opposite* of the dark-SaaS pattern where light cards
   sit on a dark ground, and it is the single strongest thing that makes a page read
   as an editor rather than as a website.

2. **Separation is a 1px line, not space and not shadow.** The line is `#2B2B2B`.
   Every region is edged by one. Regions sit edge to edge with no margin between
   them. Shadow exists only on things that float.

3. **Density is a feature.** List rows are 22px, UI text is 13px, icons are 16px.
   Section headers are 22px. Buttons are 26px. If something looks airy it is wrong.

4. **One accent.** `#0078D4`, for focus, the picked ring, the primary button, badges
   and progress. Every other colour on the page carries a meaning — git status,
   symbol kind, a live signal — and the meanings are listed below. A colour with no
   meaning is decoration, and nothing here is decoration.

5. **Actions hide until hover.** Icon buttons in section headers, row actions, the
   follow mark on a member, the follow mark on a box: shown when the thing they act
   on is under the cursor or active, and otherwise absent. This is the signature
   most people recognise without being able to name it.

---

## Tokens

Defined once in `web/src/styles.css` `:root`. Component rules use these names and
never a hex of their own — a hex in a rule below `:root` is a bug.

```
chrome          --vsc-chrome-bg    #181818    menubar, sidebars, activity, statusbar
canvas          --vsc-editor-bg    #1F1F1F    the diagram surface
floating        --vsc-widget-bg    #202020    menus, tooltips, the group editor
palette         --vsc-quickinput-bg #222222   ⌘K
input           --vsc-input-bg     #313131

line            --vsc-border       #2B2B2B    every region edge
input line      --vsc-border-input #3C3C3C
menu line       --vsc-border-menu  #454545

text            --vsc-fg           #CCCCCC    body — never pure white
strong          --vsc-fg-strong    #FFFFFF    the focused box, an active title
muted           --vsc-fg-muted     #9D9D9D    descriptions, paths, counts
disabled        --vsc-fg-disabled  #868686

accent          --vsc-accent       #0078D4    the one accent
link            --vsc-link         #4DAAFC

git added       --vsc-git-added     #2EA043
git modified    --vsc-git-modified  #E2C08D   amber — also "just written"
git untracked   --vsc-git-untracked #73C991
git deleted     --vsc-git-deleted   #F85149
info            --vsc-info          #3794FF   "the agent asked about this"
warning         --vsc-warning       #CCA700
error           --vsc-error         #F85149

graph lanes     --vsc-graph-1 … -5  #FFB000 #DC267F #994F00 #40B0A6 #B66DFF
                                              VS Code's scmGraph.foreground1–5;
                                              lane 0 is the accent

class, interface, type   --vsc-sym-class / -interface / -type   #4EC9B0
function, method         --vsc-sym-function / -method            #DCDCAA
field                    --vsc-sym-field                         #9CDCFE

radius          --vsc-radius        2px       controls, boxes, badges
radius floating --vsc-radius-widget 5px       menus, palette, popovers
shadow          --vsc-shadow-widget           FLOATING LAYERS ONLY

row             --vsc-row-h         22px
status bar      --vsc-statusbar-h   22px
title bar       --vsc-titlebar-h    35px
```

The symbol-kind colours are Dark+ syntax colours, because that is what a symbol
kind is: it is the same information an editor colours, coloured the same way.

---

## What each colour on the canvas means

A box can carry several signals at once, and they have to stay tellable apart.
Each one is a different *kind* of mark, not just a different hue:

| signal | mark | colour |
|---|---|---|
| picked (you clicked it) | 2px ring around the box | accent |
| focused (you navigated here) | the box border and title | strong white |
| just written | border pulse, holds a tint | git modified, amber |
| the agent asked about it | border pulse | info blue |
| git status | a letter badge in the title | the git colour |
| language | a small muted tag in the title | none |
| frozen at a commit | a chip in the breadcrumb row, `Viewing 7fe7f88 · 2 days ago ✕` | badge grey, like the filter chips |
| a thread in the commit graph | a 1.5px line in the lane column | the accent for lane 0, then graph 1–5 |
| a test, fixture or story | a small muted `test` tag in the title, beside the language tag | none |
| a file that would not fully parse | a 16px `codicon-warning` in the title, before the language tag | warning |
| too many boxes to place quickly | a chip in the breadcrumb row, `⚠ 289 boxes — depth 1 is quicker` | warning |
| a stored name that matches nothing | a row under "Stored, matches nothing" in Categories | muted |
| a symbol the test suite never ran | a 5px dot in the member row, left of the follow mark | disabled grey |

`--vsc-warning` means one thing: **the tool's own gap** — cannot read, could not
parse, too many to place. Do not give it a fourth meaning. Coverage is not a fault
and does not get it: a never-executed symbol wears the disabled grey, and a symbol
with no measurement wears nothing at all, because absent is not zero.

Blue is the agent's. Amber is the file system's. The accent is yours. Do not give a
new signal one of those three hues — the frozen chip was blue for a day and shared
the agent's colour with a state that has nothing to do with the agent.

Group frames keep the eight colours a person chose for them, at a 6% fill and a 40%
border. Those are the user's own meaning and are not subject to rule 4.

---

## Regions

```
┌─────────────────────────────────────────────────────────────────┐
│ MENU BAR  35px   codemap  File Edit Selection View Go Help      │ chrome
├─────────────────────────────────────────────────────────────────┤
│ BREADCRUMB 22px  root › src  [Viewing 7fe7f88 ✕] [filters] ⌘K   │ chrome
├──────────┬──────────────────────────────────────┬───────────────┤
│ LEFT BAR │                                      │ SIDE BAR      │
│ 300px    │           CANVAS  #1F1F1F            │ 330px         │
│ chrome   │                                      │ chrome        │
│ ▾ <repo> │                                      │  ▾ Following  │
│ ▾ Source │                                      │  ▾ Detail     │
│   Control│                                      │               │
│ ▾ Categories                                    │               │
│ ▾ Activity                                      │               │
├──────────┴──────────────────────────────────────┴───────────────┤
│ STATUS BAR 22px  ⎇ main ↑2 ↓0 · Changes [4]     55 boxes · TS 55 │ chrome
└─────────────────────────────────────────────────────────────────┘
```

- The menu bar is the title bar. Nothing in a menu is decoration.
- The breadcrumb row is a toolbar: crumbs separated by a chevron, then the commit
  the diagram is frozen at, then the active filters as chips, then search.
- The left bar and the side bar are side bars in VS Code's sense: `#181818`,
  edged by a 1px line, made of 22px sections with a chevron that really folds. The
  left bar is Repository (titled with the repository's own name), Source Control
  (Changes and Graph as nested 22px headers, indented 8px), Categories (the
  groups, called categories on the page) and Activity. The side bar is Following
  and Detail.
- The status bar holds what the project *is*: branch, ahead/behind, the changed
  count, boxes and files, languages, the agent's connection. Every item is either
  information or runs something. The vocabulary is VS Code's — "Changes", "Diff
  against HEAD · HEAD~1 · merge base" — never "vs HEAD".
- The welcome screen covers the canvas, not the window. The chrome stays reachable.
- `body` never scrolls. Every region scrolls inside itself.

---

## Components

**Section header** — 22px, a `codicon-chevron-down` that folds the section, the
title in **title case** at 11px bold (`Following`, `Detail`, `Categories`, `Activity` —
not uppercase; the user's VS Code does not uppercase them), and `.section-actions`
at the right edge, hidden until hovered and not rendered while folded. Between the
title and the actions sits `status`, always shown: a count, a short sha,
"Suggesting…" — information, never a control.

**List row** — 22px, 8px left padding, full width to the edge, no radius. Hover
`#2A2D2E`. Selected `#04395E`. Per-row actions in `.row-actions`, hidden until the
row is hovered. Git letters right-aligned in the git colour.

**Box** — 1px `--vsc-border`, `--vsc-widget-bg`, 2px radius, **no shadow**. Header
38px, member rows 17px. Those two numbers are `HEADER_HEIGHT` and `ROW_HEIGHT` in
`web/src/layout.ts`; dagre places every box from them and every group frame is drawn
around where the boxes land. A pixel of change moves every frame. Member rows are
UML compartments, not list rows — the 22px rule does not apply to them.

**Commit graph** — one 22px row per commit: an SVG lane column at 12px a lane,
1.5px threads in the lane colours, a 6px dot, a curve where a thread changes lane,
then the subject, the refs as 18px badges (the checked-out branch on the accent
with a target icon, tags and remotes in badge grey with their codicon, a detached
HEAD says so), and author · age muted, cut from the front so the age survives. The
selected row is the commit on screen — the list-selection fill only, no ring, so a
keyboard user can tell it from the focused row. The column is as wide as the busiest
row and scrolls sideways past the panel; a commit is never drawn without its dot.

**Repository panel** — three blocks, Project · Remote · Claude Code, each a list of
22px label · value rows with a 76px muted label, the full value in the row's title,
and one 26px full-width button under it. In a browser the "Open folder" slot holds
the CLI line in `<code>` instead.

**Categories** — a group found inside another sits one indent (24px) under its
parent and its files one more (40px). Names in groups.json that match nothing are
a block under the list, titled `Stored, matches nothing` the way a Repository block
is titled; each row is a group row whose name is muted and is not a control, with
the file count where the cohesion goes and a trash in `.row-actions` on hover.

**Menu, palette, popover** — the only things with `--vsc-shadow-widget`. 5px radius,
`--vsc-border-menu`. Menu rows 26px, the selected one is the accent full width.
The palette is Quick Pick: a 26px input on top, 22px rows, the matched characters
coloured rather than highlighted, the key hint on the active row only.

**Button** — 26px tall, 12px sides, 2px radius. Primary is the accent with white
text. Secondary is transparent with `--vsc-fg`. Full width inside a side bar.

**Input** — 26px, `--vsc-input-bg`, 1px `--vsc-border-input`. Focus turns the border
the accent. No glow.

**Icon** — a Codicon, 16px, `currentColor`, `aria-hidden`, with the meaning kept in
the button's `title` and `aria-label`. Never an emoji, never a unicode glyph. The UML
visibility marks (`+ − #`), the git letters, and `·` are text and stay text.

**Scrollbar** — 14px overlay, no track, no radius, thumb `#79797966`.

**Focus ring** — 1px solid accent, `outline-offset: -1px` in lists and `2px` on
standalone controls. Never a glow, never removed.

---

## What is not allowed

The list of things that make a page look generated, with the reason each is out:

- `border-radius` above 6px. Round corners on a control read as a website.
- `box-shadow` on anything that does not float. Elevation here is a 1px line.
- Gradients, blur, glow, inner shadow.
- A card: padding, its own background, a shadow, sitting in a grid with a gap.
- A lilac or indigo accent. The app's old `#7aa2f7` was exactly this.
- Pure white body text.
- Tracked-out uppercase labels. `letter-spacing` is never set.
- Emoji or unicode glyphs as icons.
- `transition: all`, hover transforms, fade-and-slide. Hover changes colour at once.
- Air between rows. Rows sit edge to edge.
- A second accent, or the accent used because it looks nice.
- Anything in a menu or a bar that does not run something.

---

## What this app is not

A design brief for "make it look like VS Code" will suggest these, and they are
wrong for this app. Each has been considered and refused:

- **An activity bar with one icon per visualisation type.** There is one
  visualisation. Icons for dataflow, database and infrastructure would open nothing,
  and CLAUDE.md says those are not to be built.
- **Tabs for open visualisations.** There is one.
- **A bottom panel with Problems / Agent log / Diff.** None of those exist. The
  activity table is the agent log, and it is a side bar section.
- **A second command palette.** ⌘K is one. It is styled as Quick Pick.
- **A custom Tauri title bar.** An engineering project, not a restyle.
- **Syntax-highlighted source.** The app never renders source.

---

## Measuring

Measure with `offsetHeight`, never `getBoundingClientRect` inside the canvas. React
Flow scales the canvas, so a 17px row reads as 22px at zoom 1.3 and 9px at 0.55.
Read colours with `getComputedStyle`, not from the source. Grep the *built* CSS in
`dist/web/assets` for a stray hex or radius, not the source — the source has
comments that name the old values.

The checklist a change to `web/` has to pass, with the page in front of you:

- No `border-radius` above 6px in the built CSS.
- No `box-shadow` outside menus, the palette, tooltips and the group editor.
- Chrome `#181818`, canvas `#1F1F1F`, every region edge a 1px `#2B2B2B`.
- List rows 22px, section headers 22px, member rows 17px, box header 38px.
- Only `#0078D4` as accent; `7aa2f7`, `bb9af7`, `9ece6a`, `e0af68` absent. The
  five lane hexes (`ffb000`, `dc267f`, `994f00`, `40b0a6`, `b66dff`) are expected.
- Every icon a Codicon that renders — no missing-glyph boxes.
- Section and row actions absent until hovered.
- A group frame still hugs its members after any change near `layout.ts`.
- `document.body.scrollHeight === innerHeight`.
