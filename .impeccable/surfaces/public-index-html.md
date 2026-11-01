---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# Surface: app shell (public/index.html)

Mode: Operate. Audience: open-source devs supervising 3–5 Claude Code agents for hours. Task: see which agent needs them, read the stream, approve, review diff, merge.

## Direction contract

THESIS: every workspace is a metro line leaving `main`; its colour and number follow it everywhere so you never lose which agent you are looking at. Refuses the category default (dark grey + one violet accent, anonymous dots).

OWN-WORLD: white ground, ink #1a1a1a, grey #eef0f2 surfaces, hairline #dde0e4; line palette (RATP-like yellow, blue, green, brown, pink, orange, purple, turquoise) reserved for workspace identity only; red only for "needs you" and errors; round numbered line badges; Figtree 500/700 self-hosted, JetBrains Mono for code only; tabular figures. Dark theme mirrors it on #111315.

STORY: glance at the sidebar map → see which lines run, which wait for you (red), which have commits ready → click → read thread, approve the red permission card → diff on the right → PR/merge.

FIRST VIEWPORT: 288px sidebar: brand, then each repo group drawn as a line map: a grey trunk starting at a hollow 'main' terminus station, every workspace row a coloured stub leaving it to a round numbered badge (number = ⌘ shortcut), name, state pill, task. Main: header row (name, branch pill with badge), second row of selects and actions with PR as the only ink primary; thread + composer left, Diff/Terminal/Run panel right carrying the same badge. Permission card (red) sits above the composer.

FORM: candidate 1 of 7 (Plan de métro), chosen as IMPECCABLE'S PICK after re-roll 1. seed:725764f0a48bc606

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
