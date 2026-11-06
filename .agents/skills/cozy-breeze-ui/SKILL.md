---
name: cozy-breeze-ui
description: Create polished, soft, airy, friendly web interfaces with sky-blue and mint-green pastel palettes, subtle dot textures, bento grids, gentle microinteractions, and strong readability. Use when building or redesigning Vue, React, HTML/CSS, dashboards, landing pages, apps, or components in a cute but mature visual style. Avoid pink-dominant themes.
---

# Cozy Breeze UI — Sky Blue & Mint Design Skill

## Purpose

Build interfaces that feel **airy, delightful, calm and crafted**: the tactile softness of illustrated editorial sites, with professional hierarchy and accessible usability. The design should have personality without becoming childish, generic, or overly decorative.

**Primary colors: sky blue and mint / sage green. Do not default to pink, magenta, purple gradients or a pink-tinted page.** Pink is not an accent unless the user explicitly requests it.

Respect existing products' branding and any explicit user request over this skill's defaults.

## When to apply

Use for requests to create, redesign, polish, or implement frontend screens, landing pages, tool sites, reading apps, web dashboards, component libraries, and reference-image-to-UI work. Works with Vue 3, React, Next.js, Nuxt, plain HTML/CSS, Tailwind and UI libraries. Adapt to the existing stack; do not needlessly migrate frameworks or add dependencies.

## Visual direction

- Mood: **clean spring morning, soft sky, a hint of sea breeze**, with restrained kawaii/charming touches.
- Layout: clear heading, generous-but-controlled whitespace, cards clustered in **bento grids**, easy-to-scan content.
- Surfaces: warm-neutral or cool-white bases, white translucent cards, subtle border and small soft shadows.
- Decoration: tiny dotted or grid textures (low contrast), soft radial gradients, sparse sparkles/leaves/clouds, optional small custom mascot illustration when genuinely relevant.
- Shape: friendly, cohesive corner radii; 12–18px for cards, 8–12px for inputs and buttons, pill for tags. Never round everything indiscriminately.
- Type: a legible Chinese-capable system stack; expressive large headings with consistent hierarchy, never rely on an emoji as the only label.
- Motion: restrained entrance animation (opacity + short translate), hover elevation 2–3px, transition 160–240ms; honor `prefers-reduced-motion`.
- Details: careful alignment, spacing rhythm, accessible focus indicators, credible empty/loading/error states.

## Approved palettes

Choose ONE palette for a page. Use 60/30/10 weighting for base/surface/accent, not a rainbow interface.

### A. Sky Blue (default)

| Token | Hex | Intended usage |
|---|---|---|
| `--bg` | `#F6FAFF` | page background |
| `--bg-alt` | `#EAF5FF` | soft blue wash |
| `--surface` | `#FFFFFF` | cards |
| `--primary` | `#4D9DE0` | active states / primary CTA |
| `--primary-hover` | `#267DBF` | hover |
| `--primary-soft` | `#D9EEFF` | soft labels |
| `--secondary` | `#77CDBA` | mint secondary accent |
| `--ink` | `#233B50` | main copy |
| `--muted` | `#637D90` | body secondary copy |
| `--border` | `#DCEBF4` | borders |

### B. Mint Green

| Token | Hex | Intended usage |
|---|---|---|
| `--bg` | `#F5FCF9` | page background |
| `--bg-alt` | `#E7F6EF` | mint wash |
| `--surface` | `#FFFFFF` | cards |
| `--primary` | `#2F9D82` | interactive green (readable on white) |
| `--primary-hover` | `#227B66` | hover |
| `--primary-soft` | `#D7F3E8` | soft labels |
| `--secondary` | `#7DB9E8` | sky accent |
| `--ink` | `#24443D` | main copy |
| `--muted` | `#627F76` | body secondary copy |
| `--border` | `#D9EBE2` | borders |

### C. Blue–Mint Hybrid

Use `#F7FBFD` background, `#4D9DE0` primary, `#58B99B` secondary, `#234052` ink, and `#DBEBEF` borders. Keep blue and mint complementary rather than split 50/50 everywhere.

**Never use light pastel text on white for primary content.** Darken colored text, or place it on a suitable tinted surface. Test WCAG contrast (target >=4.5:1 for normal text, >=3:1 for large text and essential UI boundaries).

## Reusable composition patterns

1. **Hero**: small overline badge → sharp, readable headline (optional single soft-colored highlighted phrase) → two-line value proposition → one clear CTA. A light decorative visual may sit beside it on wide screens; stack on mobile.
2. **Feature bento**: 2 columns on small/medium screens, 3 on wide screens if card width permits. Each card has a *muted tinted number/icon block*, strong title, concise description; do not crowd.
3. **Discovery area**: search field, filter chips, meaningful results, friendly empty state. Controls must actually work.
4. **Floating ornaments**: 2–4 subtle stars / leaves / clouds in the whole hero, not throughout the interface. Avoid random emoji overload.
5. **Callouts**: pale-blue or mint tints with modest borders; avoid giant colored fills behind dense text.

Use content-driven layouts. Do not apply every pattern to every page.

## Reference screenshot workflow

If an image is provided:
1. Identify layout, spatial hierarchy, typography, radius, density, and visual rhythm.
2. Extract reusable *design principles*, not copyrighted illustrations, logos, exact copy, or proprietary branding.
3. **Translate all pink/purple dominant hues to the selected blue/mint palette**, preserving relative brightness and contrast.
4. Implement with real semantic HTML and responsive CSS, using user-provided assets or original lightweight SVG/CSS decorations; do not fake functioning features.
5. Compare to the reference and check alignment and mobile layout.

## Implementation process

1. Read current project setup, routes, styling conventions, reusable components, and user constraints.
2. Pick one palette; state the choice briefly if helpful. Start with existing design tokens; integrate instead of overriding everything.
3. Define reusable CSS variables/tokens for `bg`, `bg-alt`, `surface`, `primary`, `primary-hover`, `primary-soft`, `secondary`, `ink`, `muted`, `border`, `shadow`, and `radius`.
4. Build semantic and responsive components. Mobile-first; check 360px, 768px, 1280px. Maintain comfortable touch targets (around 44px when feasible).
5. Make actual interactions functional: search, filters, navigation, accordions, inputs, keyboard controls, etc. Never pretend decorative components are interactive.
6. Review contrast, focus rings, loading/empty states, responsive overflow, console errors, animation reduction.
7. When browser or screenshot tools are available, run a preview, inspect screenshots and fix problems before finalizing. If not, say verification was limited.

## CSS starter (adapt; do not blindly paste)

```css
:root {
  --bg: #F6FAFF;
  --bg-alt: #EAF5FF;
  --surface: #FFFFFF;
  --primary: #4D9DE0;
  --primary-hover: #267DBF;
  --primary-soft: #D9EEFF;
  --secondary: #77CDBA;
  --ink: #233B50;
  --muted: #637D90;
  --border: #DCEBF4;
  --radius-card: 16px;
  --radius-control: 10px;
  --shadow-card: 0 10px 28px rgba(55, 109, 148, .08);
}
.page {
  color: var(--ink);
  background:
    radial-gradient(circle at 90% 9%, rgba(154, 216, 255, .23), transparent 35%),
    radial-gradient(circle at 5% 92%, rgba(139, 220, 194, .21), transparent 36%),
    var(--bg);
}
.dot-texture {
  background-image: radial-gradient(rgba(90, 149, 167, .12) .7px, transparent .7px);
  background-size: 18px 18px;
}
.cozy-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}
.cozy-card:is(:hover, :focus-within) { transform: translateY(-2px); }
:focus-visible { outline: 3px solid var(--primary); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

## Avoid

- Pink as the default theme, pink-to-purple gradients, bright neon, aggressively saturated rainbow chips.
- Generic purple SaaS heroes, endless glassmorphism, excessive blur, giant empty spaces.
- Copy-paste cards lacking content hierarchy, unaligned icons, cramped mobile grids.
- Emoji-only mascots in a production deliverable when real imagery is requested.
- Low-contrast body text, placeholder buttons without behavior, inaccessible hover-only interaction.
- Introducing unnecessary dependencies just for minor visuals.

## Final quality gate

Before reporting completion, verify: distinct visual identity; blue/mint palette; readable text; intentional spacing; responsive behavior; actual functionality; accessible keyboard focus; no overflow; no misleading claims about testing. Mention meaningful choices and any remaining limitations concisely.

## Example trigger prompts

- "用 cozy-breeze-ui 设计一个浅蓝色的动漫风剧情阅读网站，要求精致、清爽、有点阵背景和功能卡片。"
- "Use cozy-breeze-ui to redesign this Vue 3 dashboard in a pale mint theme, keeping all behavior intact."
- "参考这个截图的布局，但替换成清新天空蓝和薄荷绿，不要粉色。"
