# Digital Leaders 2026 — World Map · Handover

For the web developer taking this into production.

This is a self-contained static visualisation: D3 v7 + TopoJSON, no framework,
no build step for the app itself. It runs from any static host and is designed
to be embedded in the Digital Leaders Webflow site.

**Nothing here has been published.** The repository has not been pushed
anywhere; the commit history is included so you can push it to the company
GitHub as-is.

---

## 1. Quick start

```bash
cd viz
python serve.py          # http://localhost:8000/index.html
```

If you would rather not use Python, any static server works — but see
[§6 Gotchas](#6-gotchas-worth-knowing-before-you-start) first, because the
default `python -m http.server` causes a caching problem that will waste your
afternoon.

To see it with no server at all, open `dist/dl-map-offline.html` directly.

---

## 2. Publishing it

The repository is committed on `main` and has no remote. To publish:

```bash
git remote add origin https://github.com/<org>/digital-leaders-map.git
git push -u origin main
```

The repository must be **public** if you intend to use jsDelivr.

### What is and isn't in the repository

`data/dl-data.json` holds every institution's rank in every ranking, for both
editions. It is public by necessity — a browser-based map must download what
it displays — and Emerging has confirmed that is fine.

Two things are deliberately kept out, and should stay out:

- **Per-institution DL Points.** They are `151 − rank`, and the front end
  computes them at runtime. Publishing them would hand out the
  module-by-module breakdown that the interface is built to withhold, which is
  the basis of the commercial offer in the institution card.
- **The master Excel workbook.** It is the source of truth, lives one directory
  above the repository, and is excluded in `.gitignore`. Do not add it.

---

## 3. Embedding it in Webflow

### Option A — iframe (recommended, works today)

Publish the repository with **GitHub Pages** (Settings → Pages → deploy from
`main`, root), then in Webflow drop an Embed element:

```html
<div style="position:relative;width:100%;height:80vh;min-height:600px;">
  <iframe
    src="https://<org>.github.io/digital-leaders-map/index.html"
    style="position:absolute;inset:0;width:100%;height:100%;border:0;"
    title="Digital Leaders 2026 — World Map"
    loading="lazy"></iframe>
</div>
```

This is the path I would take first: it is exactly what has been tested, it
cannot collide with Webflow's own CSS, and the map manages its own layout.

Note that jsDelivr is **not** a good iframe target — it serves HTML files with
headers that stop them rendering as pages. jsDelivr is for the individual
assets in Option B, not for `index.html`.

### Option B — inline component

If the map has to share the page's DOM (for SEO, or to interact with other
Webflow elements), it can be mounted directly:

```html
<div id="dl-map" style="width:100%;height:80vh;"></div>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script src="https://cdn.jsdelivr.net/npm/topojson-client@3"></script>
<script src="https://cdn.jsdelivr.net/gh/<org>/digital-leaders-map@v1.0/scales.js"></script>
<script src="https://cdn.jsdelivr.net/gh/<org>/digital-leaders-map@v1.0/index.js"></script>
<script>
  DigitalLeadersMap.init('#dl-map').then(context => {
    DigitalLeadersMap.render(context, DigitalLeadersMap.getState(), context.data);
    DigitalLeadersMap.buildModuleSelector(context);
    DigitalLeadersMap.buildMetricSelector(context);
    DigitalLeadersMap.buildFilters(context);
    DigitalLeadersMap.buildSearch(context);
  });
</script>
```

Two things need doing first, and they are the reason this is Option B:

1. **The page CSS lives inside `index.html`'s `<style>` block.** Only the design
   tokens are in a separate file (`tokens.css`). To mount inline you need to
   extract that block into an `app.css`, and namespace it — it currently styles
   bare `header`, `main` and `button`, which will fight Webflow.
2. **`CONFIG.dataUrl` and `CONFIG.boundariesUrl`** at the top of `index.js` are
   relative paths. Point them at the jsDelivr URLs, or set
   `window.DL_EMBEDDED = { data, atlas }` before the script runs and it will use
   that instead of fetching (this is how the single-file build works).

**Pin a version.** Use `@v1.0`, never `@main` — jsDelivr caches aggressively and
a `@main` URL can change under a live page without warning. Tag releases:

```bash
git tag v1.0 && git push origin v1.0
```

To force a refresh of a mutable URL: `https://purge.jsdelivr.net/gh/<org>/<repo>@main/index.js`

---

## 4. What every file is

### The application

| File | Role |
|---|---|
| `index.html` | The page. Markup, all component CSS in one `<style>` block, and the bootstrap script that wires the controls at the bottom. **The Digital Leaders logo is inline SVG here** — see §6. |
| `index.js` | The whole map, ~2,600 lines. Exposes `window.DigitalLeadersMap`. Sections are signposted with banner comments: config, state, init, rendering, filtering/aggregation, metrics, controls, search, map layers, zoom, detail panels. |
| `scales.js` | D3 colour and size scales, and value formatting. The country ramp and the per-ranking colours live here and must stay in step with `MODULE_COLORS` in `index.js`. |
| `tokens.css` | Design tokens: Emerging palette, Digital Leaders blue, type scale, spacing, radii, plus the SVG map element styles (`.country`, `.hub`, `.institution-dot`). **The theme is light**, so every surface token is a paper value and the country ramp runs pale to orange. `--color-gold` is retired and aliases to the orange accent. |
| `serve.py` | Development server. Threaded, sends `no-store`, and version-stamps asset URLs. Not needed in production. |

### Data

| File | Role |
|---|---|
| `data/dl-data.json` | **The only data file the page loads.** 276 institutions, 41 countries, 15 hubs. Generated — never edit by hand. |
| `data/countries-110m.json` | Natural Earth 110m country boundaries, TopoJSON. Static; no reason to touch it. |

### Assets

| File | Role |
|---|---|
| `assets/digital-leaders.svg` | The Digital Leaders logo, byte-identical to the file Emerging supplied. |
| `assets/emerging-white.png` | The Emerging wordmark, reversed for dark backgrounds, orange accent preserved. |
| `assets/Fichier 1–3.svg` | The three original logo variants as delivered. Kept for reference. |
| `vendor/d3.v7.min.js`, `vendor/topojson.v3.min.js` | Vendored libraries, for the offline build. |
| `vendor/montserrat.css`, `vendor/lexend.css` | Base64 webfonts. **Lexend is not decorative** — the logo SVG contains live text set in it, and without it the wordmark breaks apart. See §6. |
| `vendor/fetch_fonts.py`, `vendor/fetch_lexend.py` | Regenerate those two files. Only needed if the weights change. |

### The data pipeline (Python; not needed to run the map)

| File | Role |
|---|---|
| `build_data.py` | Excel → `data/dl-data.json`. **The Excel is the single source of truth.** `--check` rebuilds and diffs without writing, so it doubles as a regression test. |
| `geocode.py` | Looks up every institution against OpenStreetMap Nominatim, cached in `geocode_cache.json`. `--apply` writes coordinates into the workbook. |
| `geocode_aliases.py` | Second pass for English exonyms ("Polytechnic University of Milan" → *Politecnico di Milano*), plus three coordinates set by hand. |
| `verify_geocode.py` | Flags results that resolved to the wrong country. |
| `audit_hubs.py` | Derives hub membership from coordinates by per-hub radius. `--apply` writes it. |
| `audit_hubs_full.py` | Per-hub quality report: members, distances, anyone nearby but untagged. |
| `integrate_next50.py` | One-off: merged the Next 50 into the workbook. Kept as the record of how it was done. |
| `bundle.py` | Builds the two single-file versions in `dist/`. |

### Builds

| File | Role |
|---|---|
| `dist/dl-map-standalone.html` | Everything inlined — libraries, fonts, data, logos. Page content only, no `<html>` wrapper. |
| `dist/dl-map-offline.html` | The same with a full HTML wrapper, so it opens by double-clicking. Useful for sending to stakeholders. |

Both are regenerated by `bundle.py` and are ~2 MB. They need no network at all.

---

## 5. Updating the data

The Excel workbook is the source of truth. After any change to it:

```bash
python geocode.py            # only if institutions were added
python geocode_aliases.py    # only if geocode.py failed on any
python audit_hubs.py --apply # only if institutions or coordinates changed
python build_data.py         # always
python bundle.py             # always
```

Then verify against three figures that should not move unless the data really
changed:

- USA reads **44** ranked institutions in Data and AI and **62** in Computer Science
- Golden Triangle reads **7** in Global
- the key strip under the controls reads
  **264 institutions · 41 countries · 15 hubs**

If those drift, something upstream broke.

---

## 6. Gotchas worth knowing before you start

**The logo must stay inline SVG, and Lexend must ship with it.**
`digital-leaders.svg` contains live `<text>`, not outlined paths, set in
Lexend-Light and Lexend-Medium, and every `<tspan>` carries a hard-coded `x`
from the original Illustrator export. Without the font the browser substitutes
another, the fixed positions no longer match the glyph widths, and the wordmark
splits into "digi tal" and "Ca reers". An SVG loaded through `<img>` is an
isolated document and cannot use the page's fonts — which is why it is inlined
in `index.html` between `<!-- dl-logo:start -->` markers. Do not convert it back
to an `<img>`.

**Do not strip `width`/`height` from that SVG with a global replace.** Its
`<svg>` root carries none, so a document-wide replace removes the first two it
finds — which belong to the `<clipPath>` rect that masks the swoosh. A rect with
no dimensions clips to nothing and the swoosh silently disappears.

**Never use `python -m http.server` for development.** It is single-threaded, so
one held-open browser connection blocks every other request and the server
looks dead; and it sends no `Cache-Control`, so the browser reuses a stale
`index.js` while the HTML updates around it, producing a half-updated page
that is very confusing to debug. `serve.py` fixes both.

**A zoom transform is in pixels.** Opening the detail panel narrows the map by
340px, the `ResizeObserver` refits the projection, and any transform computed a
moment earlier now points somewhere else. The map therefore stores what it is
looking at as *geography* (`context.focus`) and re-applies it after every
reprojection. If you change the layout, keep that mechanism.

**Marker radii: compute in screen pixels, then divide by the zoom once.**
Markers live inside the zoom group, so what the reader sees is `attribute × k`.
Flooring the attribute makes dots grow at high zoom, which is the opposite of
the intent.

**Institution dots are de-clustered at render time.** Some institutions share a
coordinate exactly (Delhi University and IIT Delhi), so zoom alone cannot
separate them. A collision relaxation runs in screen space and re-runs when a
zoom gesture settles; it self-cancels as real separation grows. Dots are only
ever displaced where they would otherwise be indistinguishable.

**`readableOn()` moves a colour toward the background, not always upward.**
A brand colour picked to work as a fill is rarely readable as type. On the old
dark surfaces the fix was always to lighten it; on paper it is always to darken
it, and the function now picks the direction from the background's luminance.
If you ever put a control back on a dark ground, it will lift the colour again
on its own. The `-text` token pairs (`--color-dl-blue-text`,
`--color-rising-text`, `--color-falling-text`) survive for the same reason, but
on white most of them now resolve to the true brand colour.

**The key and the coverage line are HTML, not SVG.** They used to be two `<g>`
groups pinned to the bottom-left corner of the map. They are now `#map-key`,
a strip directly under the control band, filled by `renderKey()`. If you need
to add something to the key, add it there: there is no longer a legend layer
in the SVG, and putting one back at the top of the map would collide with the
breadcrumb.

**One popover explains every control.** `#control-pop` is positioned against
whichever control asked for it, in viewport pixels. That is why anything which
moves a control (a resize) closes it rather than repositioning it. Adding a
control to the band means adding a `data-explain="key"` attribute and an entry
in `CONTROL_EXPLAINERS`; `wireExplainers()` does the rest, and has to be called
again for any markup built from the data (`buildFilters()` does).

---

## 7. Where the decisions are recorded

`git log` is written to be read. Each commit explains what changed and why,
including the approaches that were tried and rejected — the Next 50 scoring
model, the logo, the map canvas colour, the competitor methodology. If
something looks arbitrary, the commit that introduced it probably says why.
