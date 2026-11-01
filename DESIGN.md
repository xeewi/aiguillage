---
name: Aiguillage
description: A local orchestrator for parallel Claude Code agents, drawn as a metro map.
colors:
  ink: "#1a1a1a"
  ink-fg: "#ffffff"
  ground: "#ffffff"
  muted: "#5d646b"
  hairline: "#dde0e4"
  soft-grey: "#eef0f2"
  gutter: "#f7f8f9"
  term-bg: "#fbfbfc"
  trunk-grey: "#6b737c"
  signal-red: "#e3051c"
  diff-add: "#006b41"
  diff-add-bg: "#e6f3ed"
  diff-del: "#b80016"
  diff-del-bg: "#fbe7e9"
  line-1-yellow: "#ffcd00"
  line-2-blue: "#003ca6"
  line-3-green: "#00814f"
  line-4-brown: "#8d5e2a"
  line-5-orange: "#ff7e2e"
  line-6-mint: "#6eca97"
  line-7-plum: "#a0006e"
  line-8-pink: "#e19bdf"
typography:
  display:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 800
  item:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
  body:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.45
    fontFeature: "tnum"
  control:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  label:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.08em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 500
    fontFeature: "liga 0, calt 0"
rounded:
  code: "5px"
  control: "7px"
  row: "8px"
  card: "10px"
  bubble: "12px"
  pill: "99px"
  badge: "50%"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  gutter: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-fg}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-ghost:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-ghost-hover:
    backgroundColor: "{colors.soft-grey}"
  button-icon:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "4px"
    width: "26px"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  select:
    backgroundColor: "{colors.soft-grey}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  line-badge:
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.badge}"
    size: "26px"
  line-badge-sm:
    rounded: "{rounded.badge}"
    size: "20px"
  pill-running:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  pill-needs-you:
    backgroundColor: "{colors.signal-red}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  workspace-row:
    rounded: "{rounded.row}"
    padding: "9px 8px 9px 24px"
  workspace-row-active:
    backgroundColor: "{colors.soft-grey}"
  permission-card:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
  message-me:
    backgroundColor: "{colors.soft-grey}"
    rounded: "{rounded.bubble}"
    padding: "10px 14px"
  tool-row:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.row}"
    padding: "8px 12px"
  composer:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
---

# Design System: Aiguillage

## Overview

**Creative North Star: "Plan de métro"**

Every workspace is a metro line leaving the base branch. Its colour and its number follow it everywhere (sidebar stub, badge, header branch pill, panel tabs, tool stations in the thread) so the developer never loses track of which agent they are looking at. The ground is a white transit-signage sheet: ink type, grey surfaces, hairline rules; colour is spent only on line identity and on the one signal that needs a human.

Density is that of a tool used for hours: 14px body, 13px controls, a 288px map sidebar, a thread capped at 72ch, a diff/terminal panel on the right. Type is Figtree at heavy weights (700/800) for names and controls, like station signage; JetBrains Mono for code, branches and paths only, with ligatures off. Figures are tabular everywhere. Dark theme mirrors the same roles on a near-black ground (#111315): every token is `light-dark(light, dark)`, the OS picks by default and the sidebar's System / Light / Dark picker pins one (`data-theme`, stored in localStorage). Dark lifts the darkest line colours (blue #3468d8, brown #9c6b36, plum #c42f8f) to at least 3:1 on the ground while keeping white numerals at 4.5:1; Signal Red (#e3051c) and Trunk Grey (#6b737c) are the same in both themes. The terminal gets an ANSI palette per theme and re-themes live.

The world rejects the category default of a dark grey ground with a single violet accent and anonymous status dots.

**Key Characteristics:**
- The sidebar list is the map: grey trunk, hollow terminus for the base branch, coloured stubs to round numbered badges.
- Line number = ⌘ shortcut = line colour (8 colours, then they loop).
- Ink is the only primary; red is the only alarm.
- Flat sheet, hairline borders; shadows only on floating overlays.
- One inline-SVG icon set on a 16px grid, 1.75 stroke.

## Colors

Signage white and ink, with a RATP-like line palette held strictly for identity and one red held strictly for "needs you".

### Primary
- **Signage Ink** (ink): text, the primary button, running pill, toast, focus outline, active tab underline. Ink is the only "primary"; there is no brand accent colour.

### Secondary
- **Signal Red** (signal-red): the "Attend ta réponse" pill, the permission card border and its badge, the error toast. Nothing else.

### Tertiary: the line palette
- **Ligne 1 Yellow, Ligne 2 Blue, Ligne 3 Green, Ligne 4 Brown, Ligne 5 Orange, Ligne 6 Mint, Ligne 7 Plum, Ligne 8 Pink** (line-1 to line-8): workspace identity only. Applied through a single `--c` custom property set by the `lnN` class: badge fill, sidebar stub, tool-row station dot, panel/header badge. Yellow, orange, mint and pink carry ink numerals; the rest carry white.

### Neutral
- **Signage White** (ground): page, sidebar, panel, cards.
- **Platform Grey** (soft-grey): selects, own messages, inline code, hover and active rows, branch pill.
- **Hairline** (hairline): every border and divider, 1px.
- **Trunk Grey** (trunk-grey): the base-branch trunk, terminus ring, unassigned badges, dashed "add repo" border.
- **Quiet Grey** (muted): secondary text, metadata, inactive tabs, icon buttons at rest.
- **Terminal Paper** (term-bg) and **Gutter** (gutter): terminal and gutter grounds, a hair off white.
- **Diff green / red** (diff-add, diff-add-bg, diff-del, diff-del-bg): diff lines and inline error messages; semantic, never decorative.

### Named Rules
**The Identity Rule.** Line colours mean "this workspace" and nothing else. Never use one for a state, a button, a link or decoration.

**The One Alarm Rule.** Signal Red means a human is needed now (pending permission) or something failed. Running is ink, new is an ink dot on an outlined pill, failed is a red outline with an x. A plan-usage lane at 90 % or more is red too: you're about to be cut off.

**The Ink Primary Rule.** Exactly one ink-filled button per action group (Create PR in the Diff tab's git bar, Send in the composer, Start in the run bar); every other action is ghost.

## Typography

**Display Font:** Figtree (with system-ui, sans-serif), self-hosted variable 400–800
**Body Font:** Figtree
**Label/Mono Font:** JetBrains Mono (with ui-monospace, Menlo), self-hosted 400–600

**Character:** Heavy, open grotesque signage for names and controls; a plain mono for anything a machine wrote. Body sits at 500 so 700/800 headings read as signs, not shouting.

### Hierarchy
- **Display** (800, 30px, 1.15, -0.02em, balanced wrap): empty-state headline only.
- **Headline** (800, 22px): the workspace name in the header. Brand wordmark sits close (800, 19px).
- **Title** (800, 18px): dialog titles.
- **Item** (700, 15px): workspace names in the sidebar.
- **Body** (500, 14px, 1.45, tabular figures): thread text, max 72ch.
- **Control** (700, 13px): buttons, tabs, tool names, toast.
- **Label** (700, 11px, 0.08em, uppercase): repo group headers in the sidebar.
- **Mono** (500, 12.5px; 12px inside tool output): code, diffs, paths, branch names, terminus, script pill.

### Named Rules
**The Mono Is For Machines Rule.** JetBrains Mono only for code, diffs, branches, paths and terminals; never for UI labels.

**The No Ligatures Rule.** `font-variant-ligatures: none` on every code surface; `!=` and `->` must look like what was typed.

## Layout

App shell, full viewport, no page scroll on desktop: sidebar (288px, 20px/14px padding, 14px gap) | main. Main is a one-line header over a split. Each control sits where it acts: the header says where you are (name, double-click to rename; branch pill) with only an « Open ▾ » menu (VS Code, folder) and a « ⋯ » menu (rename, archive), both native popovers anchored under their button; the composer sets the next message (model, effort and permissions as quiet borderless selects left of Send; when the composer is too narrow, earlier while Stop is shown, they fold into one summary chip, permissions first, then only what overrides the CLI defaults, e.g. « Plan · Opus · high », which opens them above it; the « working » label leaves only its spinner); the Diff tab ships what you just read (a git bar with the file count and +/− totals, then Commit, Merge and the ink Create PR; disabled while there is nothing to commit or ship). The Diff tab label carries the +/− totals so pending work shows from any tab. The split is thread + composer (28px side gutters) and the Diff / Terminal / Run panel (46% beside, 45% below), divided by a 1px draggable gutter (keyboard arrows, double-click resets); a button in the tab bar puts the panel beside or below the chat. Both choices and the sizes are remembered. The sidebar collapses to a 64px rail of badges (78px in the desktop app, under the traffic lights), the state pill shrinking to a dot on the badge.

Spacing steps are 2/4/8/12/16/20/28 with occasional 6/10/14 inside components. Thread items gap 12px; sidebar rows gap 2px.

Responsive: at ≤900px the sidebar narrows to 220px (state pills drop under the task line), the panel is always under the chat and gutters drop to 16px. Desktop only, no phone layout; the ≤900px step is for narrow desktop windows.

## Elevation & Depth

Flat by default: depth is a hairline (1px) and a step from white to Platform Grey. The only shadows belong to things that float above the sheet.

### Shadow Vocabulary
- **Dialog** (`box-shadow: 0 12px 40px rgb(0 0 0 / .18)`, backdrop `rgb(0 0 0 / .35)`): modal dialogs.
- **Toast** (`box-shadow: 0 8px 24px rgb(0 0 0 / .2)`): the bottom-centre toast.
- **Active tab** (`box-shadow: inset 0 -3px 0 ink`): a 3px ink underline, not elevation.

### Named Rules
**The Floating-Only Shadow Rule.** A shadow means "this is above the page" (dialog, toast). Rows, cards and panels never get one.

## Shapes

Round where the map is round, gently rounded everywhere else. Badges, station dots and the terminus are full circles; pills are capsules (99px); the trunk and stubs are 4px bars with 2px rounded ends. Controls are 7px, rows and tool cards 8px, the permission card and composer 10px, own messages and dialogs 12px, inline code 5–6px.

**The Station Rule.** Circles are stations: a filled circle is a line badge or a completed tool, a hollow 2px ring is the terminus or a pending tool. Don't use circles as generic bullets or avatars.

## Components

### Buttons
Plain signage buttons, bold labels, no gradients.
- **Shape:** gently rounded (control, 7px), 1px border.
- **Primary:** ink fill, white label, 6px 12px, Control type.
- **Hover / Focus:** primary fades to 88% opacity; focus is a 2px ink outline at 2px offset; disabled 50% with progress cursor.
- **Ghost:** white fill, hairline border, ink label; hover fills Platform Grey.
- **Icon:** borderless, 26px minimum, Quiet Grey icon turning ink on a Platform Grey hover.
- **Icons:** one inline-SVG set (plus, more, refresh, undo, x, play, check, stop, gear, down, side, panelBelow, panelRight) on a 16px viewBox, `currentColor` stroke 1.75, round caps and joins. Icon + text buttons gap 6px.

### Chips (state pills)
- **Style:** capsule, 2px 9px, 11.5px/700.
- **States:** running = ink fill with a 6px dot; needs-you = Signal Red fill, white text, no dot; new = hairline outline with an ink dot; failed (« Échec », agent crashed or turn ended in error, cleared by the next message) = Signal Red outline and text, 10px x icon; script = hairline outline, mono, Quiet Grey, 10px play icon.

### Cards / Containers
- **Tool row (a station on the line):** hairline border, 8px radius, white; summary row 8px 12px with a station dot in the line colour (hollow while running, filled when done, red when failed). Output in Platform Grey mono blocks capped at 340px.
- **Permission card:** 2px Signal Red border, 10px radius, 12px 14px, a red 24px badge before the question. Sits above the composer.
- **Own message:** Platform Grey bubble, 12px radius, right-aligned, max 78% / 72ch. Agent messages sit on the bare ground.
- **Error message:** diff-del text on diff-del-bg, mono, 8px radius.

### Inputs / Fields
- **Style:** selects in Platform Grey, text inputs white; 1px hairline, 7px radius, 6px 10px, 13px.
- **Composer:** white, hairline, 10px radius, 12px 14px, auto-growing from 72px to 40vh; focus swaps the border to ink, no glow.

### Navigation
- **Panel tabs:** transparent, Quiet Grey Control labels; active tab is ink with a 3px ink underline. The tab bar opens with the active workspace's 20px line badge.
- **Header branch pill:** Platform Grey capsule, mono branch name, led by the 22px line badge.

### Line Map Sidebar (signature)
Each repo group: an uppercase Label header with icon buttons, then the map. A 4px Trunk Grey bar runs down the left edge from a hollow terminus labelled with the base branch in mono. Every workspace row is a 22px × 4px stub in its line colour leaving the trunk into a 26px numbered badge, then the name (Item type: the task name Claude draws from the first message, or the user's rename; the city name until then), a state pill right-aligned and, in Quiet Grey, ellipsised, the city name (or "New workspace" before the first message). The number is the ⌘1–9 shortcut and selects the colour. Hover and active rows fill Platform Grey at 8px radius. Archived rows drop the stub and badge.

### Plan Usage Lanes
Above Settings in the sidebar: one lane for the 5-hour session and one for the week, from the CLI's own `get_usage`. A lane is an uppercase Label with the percentage right-aligned (13px/800, ink), a 4px Platform Grey track filled in ink, a 2×10px Trunk Grey tick at the time elapsed in the window (a fill past the tick means you're ahead of the clock), and the reset in Quiet Grey 12px ("resets in 2h 14m", or a weekday and time beyond 24 h). Past 90 % the fill and the figure turn Signal Red. Data older than 15 min dims the lanes to 55 % and says how old it is. Hover or focus opens a floating card (toast shadow, 10px radius) listing every limit, per-model ones included, with the plan and the time it was fetched. No limits (API-key login, logged out): the block is not shown.

## Do's and Don'ts

### Do:
- **Do** route every identity colour through the `lnN` class and the `--c` property, so badge, stub, station dot and tabs badge always agree.
- **Do** keep numbering = ⌘ shortcut = colour: line number is the workspace's position in the live list, colour loops every 8.
- **Do** put ink numerals on the light line colours (yellow, orange, mint, pink) and test any new line colour for numeral contrast before shipping it.
- **Do** use the inline-SVG set at 16px / 1.75 stroke for any new icon, drawn on the same grid.
- **Do** disable ligatures on every new code surface.

### Don't:
- **Don't** use a line colour for status, emphasis, links or buttons.
- **Don't** use Signal Red for anything that isn't a pending human decision or a failure (diff deletions keep their own diff-del tokens).
- **Don't** add a second filled primary button to an action group, or a brand accent colour beside ink.
- **Don't** add shadows to rows, cards or panels; depth on the sheet is a hairline.
- **Don't** use emoji, text glyphs or an icon font as icons.
- **Don't** set UI labels in JetBrains Mono.
