# Dancing Saints — Design Guide

Based on the live website, https://saintgregorys.org/ (WordPress block theme "saint-gregorys"), read 2026-10-20: homepage, /about/the-dancing-saints/, /welcome/plan-a-visit/, and the theme's inline global styles. Values marked *(theme token)* come straight from the site's CSS; values marked *(approx.)* were judged by eye from the logo or screenshots.

## 1. Feel in one line

Warm, sunlit and welcoming: cream-to-butter backgrounds, big photography of the icon-covered rotunda and people dancing, deep teal text accents, and one hand-drawn Arts-and-Crafts display face used sparingly for titles. Plain, friendly language; never stiff or churchy.

## 2. Color

### Core palette (what the site actually uses)

| Role | Name | Hex | Source |
|---|---|---|---|
| Primary text | Black | `#000000` | theme token |
| Brand / links / filled buttons | Deep Teal ("dark") | `#155263` | theme token, most-used non-neutral |
| Page background top | White | `#FFFFFF` | theme token |
| Warm background (homepage sections) | Butter | `#FCEFBC` | gradient `#FFF → #FCEFBC` |
| Soft background (inner pages) | Cream | `#FAF6E5` | gradient `#FFF → #FAF6E5` |
| Donate / highlight | Saffron ("secondary") | `#FFC93C` | theme token |
| Accent A (eyebrows, buttons, underline) | Sunset Orange ("accent-2") | `#FF6F3C` | theme token |
| Accent B (eyebrows, buttons, underline) | Icon Green ("accent-3") | `#3B7659` | theme token |
| Accent C | Wine ("accent-4") | `#A12A44` | theme token |
| Accent D | Apricot ("accent-1") | `#FF9A3C` | theme token |
| Muted green (secondary links, contact text) | Sage | `#5E7C6D` | computed on Plan a Visit |
| Pale sage | Sage Light ("primary") | `#98BAA6` | theme token |

### Logo colors *(approx.)*
The logo's quartered cross uses four tiles that line up with the accents: yellow `#E9B630`, red `#9C2B2E`, orange `#E26A2C`, blue `#2B7EC1`. Wordmark is a near-black teal `#0F3A44`, with a short orange rule under "Episcopal Church".

### How color is applied
- Text is black on light backgrounds, white on photos.
- Each content section picks **one** accent (orange on the Dancing Saints page, green on Plan a Visit) and uses it for the eyebrow label, the short underline under the heading, and the section's button. Don't mix accents within a section.
- Photo cards get a bottom-up black gradient (`transparent 40–64% → #000 100%`) so white text sits on them.
- No dark mode on the site. For the app, a dark theme can use Deep Teal `#155263` darkened to ~`#0E2F38` as background, Cream `#FAF6E5` as text, and Saffron for highlights *(suggestion, not on the site)*.

### CSS tokens

```css
:root {
  --sg-black: #000000;
  --sg-teal: #155263;
  --sg-white: #ffffff;
  --sg-butter: #fcefbc;
  --sg-cream: #faf6e5;
  --sg-saffron: #ffc93c;
  --sg-orange: #ff6f3c;
  --sg-green: #3b7659;
  --sg-wine: #a12a44;
  --sg-apricot: #ff9a3c;
  --sg-sage: #5e7c6d;
  --sg-sage-light: #98baa6;
  --sg-bg-warm: linear-gradient(#ffffff, #fcefbc);
  --sg-bg-soft: linear-gradient(#ffffff, #faf6e5);
  --sg-photo-scrim: linear-gradient(rgba(255,255,255,0) 50%, #000 100%);
}
```

## 3. Typography

| Use | Font | Size | Weight | Letter-spacing | Line-height |
|---|---|---|---|---|---|
| Page title (inner pages), short wordmark | **StGregory** (custom display) | 68px | 300–400 | -1% | 1.2 |
| Hero headline (homepage) | Lexend Deca | 68–70px | 400 | -2px | 1.2 |
| H2 section heading | Lexend Deca | 42px | 600 | -0.42px | 1.2 |
| H3 | Lexend Deca | 26px | 600 | 0.52px | 1.2 |
| Eyebrow label above H2 | Lexend Deca | ~12–13px | 700 | wide (~0.1em) | — , UPPERCASE, accent color |
| Body | Lexend Deca | 16–18px | 300–400 | normal | 1.6 |
| Buttons | Lexend Deca | 18px (16px small) | 600–700 | 4% | inherit, UPPERCASE |

- **Lexend Deca** is a free Google Font (weights 300–900). Load from Google Fonts: `https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@300;400;600;700&display=swap`.
- **StGregory** is a custom Arts-and-Crafts face matching the logo lettering, served from `https://saintgregorys.org/wp-content/themes/saint-gregorys/assets/fonts/stgregory/stgregory-400-normal.ttf`. Its license is unknown, so ask the church before bundling it. Use it only for page titles and the "SAINT GREGORY'S" header wordmark, never for body text. Fallback if it can't be used: the logo image for the wordmark, and Lexend Deca 600 for titles.
- Fallback stack: `"Lexend Deca", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.
- **App title font: Lexend Deca.** The app uses Lexend Deca 600 (slightly tightened, -0.01em) for page titles and the app wordmark instead of StGregory. An earlier draft used Federant as a look-alike for the logo lettering; it was dropped so the app uses one typeface throughout.

## 4. Logo

- Full logo (stacked cross + wordmark, transparent PNG, 500×500): `https://saintgregorys.org/wp-content/uploads/2024/10/SGN-LOGO-renew2024final.png` — local copy `SGN-LOGO-renew2024final.png`.
- Cross mark only (app icon / favicon, 512×512): `https://saintgregorys.org/wp-content/uploads/2024/12/cropped-SGN-logo-just-cross-1.png` — local copy `SGN-cross-512.png`.
- The site shows the full logo at 280px wide on the homepage, and a compact text wordmark "SAINT GREGORY'S" (StGregory, 24px, black) in the header of inner pages.
- Keep it on white or cream; don't recolor or place it on busy photos.

## 5. Layout and spacing

- Content width **1200px**, wide sections **1360px**; side gutter 1rem (16px) on mobile.
- Spacing scale (WordPress presets): 0.44rem, 0.67rem, 1rem, 1.5rem, 2.25rem, 3.38rem, 5.06rem. Sections are separated generously (~3.4–5rem).
- **Header:** white bar with logo/wordmark left, uppercase nav (WELCOME! · ABOUT · EVENTS · CONNECT · RESOURCES) right, small search box. Homepage adds a top utility row: address, service times, phone, and a Saffron **Donate** pill.
- **Hero:** full-bleed photo of the rotunda/Dancing Saints with large white headline, a short white sub-line, and one white button with teal text. Inner pages use a shorter photo banner with the StGregory title in white bottom-left, then a right-aligned breadcrumb.
- **Section pattern:** eyebrow (uppercase accent) → H2 → short accent underline (~40px wide, 3px) → paragraph → accent-filled button aligned right.
- **Cards:** big photo tiles in a 2-up grid, with a black gradient scrim and white title + one-line tagline + uppercase "LINK TEXT >" at the bottom. Square corners on images and cards (radius 0).
- **Buttons:** radius 5–6px, uppercase, ~14px × 18px padding. Variants seen: white with teal text (on photos), teal `#155263` with white text, accent-filled (orange/green) with white text, Saffron for Donate.
- **Footer:** light background, address and phone, service times, uppercase action links (PLAN YOUR VISIT, JOIN OUR EMAIL LIST, SUPPORT OUR WORK), a Quick Links list with "›" chevrons, and social icons (YouTube, Instagram, Facebook, Spotify).
- Lists of links use a trailing "›" or ">" rather than icons.

## 6. Imagery

Real photos only: the painted Dancing Saints icon circling the rotunda, the candle-lit chandeliers, the mosaic over the entrance, and congregants of all ages dancing around the altar table. Wide, warm, color-rich. Avoid stock photos and clip-art.

## 7. Voice and tone

- Warm, inclusive and plain-spoken: "Love makes room for us all", "Come as you are", "There's a place for you to belong here", "Got questions? We've got answers".
- Sensory and wonder-filled when describing worship: "beauty, wonder, and Holy Mystery", "a feast for the senses".
- Second person ("you"), short sentences, sentence-case headings, gentle humor and exclamation where natural ("Free street parking!").
- Practical facts up front: Sunday Eucharist 8:30 and 10:30 am, Morning Prayer weekdays at 8, 500 De Haro Street, Potrero Hill, San Francisco, 415.255.8100.

## 8. Quick do / don't for the app

- Do: cream/butter backgrounds, black text, teal for links and primary buttons, one accent per screen section, big photos with scrims, Lexend Deca everywhere.
- Do: the eyebrow → heading → underline pattern for section headers.
- Don't: use the WordPress default palette colors (vivid purple, cyan, etc.) that appear in the CSS but not on the pages.
- Don't: set long text in StGregory, or put more than one accent color in one block.

## 9. App-specific decisions

- **Casing:** prefer sentence case for headings, buttons, menu items and labels, except for proper names. This overrides the site's uppercase buttons; the small eyebrow labels above headings stay uppercase as on the site.
- **Fonts:** Lexend Deca for all text, including page titles (600 weight). Self-hosted in the app.
- **Accents per screen:** browse uses orange, commentary wine, iconographer green, the desktop welcome teal.
- **Camera:** face hotspots are white rings with a teal edge so they read on the orange and blue mural; the selected face gets a saffron ring and the rest of the frame a 30% white scrim.
- **Loading:** the site's footer illustration (`SGN-web-footer`) with a saffron band scanning up and down.
- **Images:** square corners for photos and portraits (hotspots stay circular).

### Mobile type scale (base 17px)

| Use | Size / line height | Font |
| --- | --- | --- |
| Intro hero title | 40px / 1.1, 600 | Lexend Deca |
| Page title (H1) | 32px / 1.2, 600 | Lexend Deca |
| Saint name (H2) | 24px / 1.2, 600 | Lexend Deca |
| List names (H3) | 18px / 1.3, 600 | Lexend Deca |
| Body | 17px / 1.6, 300 | Lexend Deca |
| Small (dates, captions) | 15px / 1.45 | Lexend Deca |
| Eyebrow | 12px, 700, uppercase, 0.1em | Lexend Deca |
| Buttons | 16px, 600, 0.04em, sentence case | Lexend Deca |

From 700px wide: H1 42px, hero 68px, body 18px.
