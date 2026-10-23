# FILHAMSY — Original Artwork

A static, dependency-free WebGL art portfolio. A portrait liquifies into the
stationary full-color butterfly, then reveals the surrounding artwork outward.
Default playback loops forward and backward: 8 seconds per direction, 16 seconds per cycle.
The image is still determined entirely by scroll position and is reversible.

## Run

Use Node.js **24.x**, matching `package.json` and Vercel's build environment.

```bash
npm ci
npm run dev
```

`dev` serves on `http://127.0.0.1:5173`.

```bash
npm run build
npm run preview
```

`build` type-checks with TypeScript and emits a static `dist/` directory.
`preview` serves the built output on `127.0.0.1`. Asset URLs are relative
(`vite.config.ts` uses `base: './'`), so `dist/` can be deployed at a domain
root or in a subdirectory on any static host. No server-side code is required.

## GitHub and checkpoints

Checkpoint ZIPs are stored outside the repository in `../grid-system-checkpoints/`:
`approved-artwork-*.zip` preserves the approved pre-cleanup state, and
`github-vercel-ready-*.zip` contains the cleaned source. They include original
artwork and the lockfile, not `node_modules`, build output, credentials, or Git internals.

The repository is initialized on `main`. Configure your actual Git author name
and email locally before the first commit, then run:

```bash
git add .
git commit -m "Checkpoint stationary butterfly morph and outward reveal"
git tag artwork-checkpoint
```

Create an empty repository on GitHub and use its Quick Setup instructions to
add your repository URL as `origin` and push `main` and the checkpoint tag.
No GitHub remote or live Vercel deployment is created automatically.

The checkpoint intentionally retains its locked Vite 5/esbuild versions.
`npm audit` reports two development-tool advisories (one high, one moderate);
`npm audit --omit=dev` reports none. Keep the development server local and
revisit these advisories when upgrading the build tooling.


## Deploy to Vercel

Import this repository in Vercel and keep the project root set to this directory.
`vercel.json` selects Vite, installs locked dependencies with `npm ci`, runs
`npm run build`, and publishes `dist`. No environment variables, backend, or
SPA rewrites are required. Click **Deploy**; subsequent pushes to the production
branch trigger production deployments, and pull requests get preview deployments.

Alternatively, from this directory:

```bash
npx vercel
npx vercel --prod
```

The first command links the project and creates a preview; the second deploys
to production. Both require a Vercel account and CLI sign-in. Before deploying,
run `npm run build` and `npm run preview` to inspect the production output locally.


## Art direction

- **0–15% — Portrait.** Untouched, full-bleed silhouette hold on warm paper.
- **15–56% — Metamorphosis.** A continuous, swirling ink bleed pulls the rounded
  shoulders inward and reshapes the portrait into the butterfly at its final
  position. Color resolves as the contour settles; the butterfly does not
  travel off-screen, resize, or leave a clear interval.
- **56–96% — Outward reveal.** Immediately after the morph, coverage expands
  from the butterfly's body and wings to uncover the artwork and extended grain.
  Only the reveal mask grows; the artwork itself does not zoom or slide.
- **96–100% — Butterfly.** Exact final composition before playback reverses.

The shader is raw WebGL 1 with no runtime dependencies. Portrait framing uses
`cover`, aligning the head focal point (51.5%, 43% of the source) with the viewport
center and foreground mark. The final butterfly is a contained plate: up to 90%
of viewport height and 94% of width, preserving the complete artwork.
The surrounding screen extends the butterfly's blue, cream, and coral grain
instead of using a dark gradient. The shader reflects the outer 2.5% of the
artwork and scatters distant samples to avoid obvious repeated motifs; the
butterfly itself stays at its original contained size. Reduced motion uses
the same surround. The HTML fallback tiles a mirrored edge-strip derivative.


Inspired by the text treatment in [Codrops Gooey Text Hover](https://tympanus.net/Development/GooeyTextHover/).
Portrait coverage comes from `portrait-silhouette.svg`, a spline trace of the
3264×2448 original at luminance 0.33, generated with VTracer 0.6.15 (binary mode,
no speckle removal, corner threshold 60, length threshold 1, 10 iterations,
splice threshold 45, path precision 3). It retains 101 paths, including small
hair details and holes. Against the same thresholded original, the rendered
trace measured 99.79% intersection-over-union; it is an approximation, not a
lossless conversion of soft hair or paper grain.

Both silhouettes are rasterized once at load, capped at 2048 px (1600 for the
portrait on coarse pointers). Each texture packs antialiased sharp coverage in
G and blurred goo in R. `butterfly-silhouette.svg` is a simplified, hand-traced
outline following the artwork's red upper wings, navy lower wings, body, and
antennae; it is a morph and reveal mask, not a replacement for the original art.
Its `55 410 600 320` viewBox is registered to the `709×1075` source plate;
texture UV registration accounts for the bottom-up Y direction. Morphing and
outward reveal use this same mapping so the butterfly cannot jump between them.

A soft ink threshold and broad, progress-driven displacement reshape the
portrait into the registered wing field. A rounded cap closes the cropped
shoulders before liquifying them, avoiding the photograph's rectangular
bottom edge. The morph gains the original butterfly's color and finishes at
the same coverage that starts the expanding reveal, without a separate exit,
return, or pause. The increasingly soft wing mask uncovers the surroundings
outward from the body, then fills the remaining frame. The exact final
composition holds from 96% onward.
All stages depend only on scroll progress and reverse with it.

There is no generated Bayer dithering or color quantization. Grain belongs to
the original artwork and extended background. The foreground mark stays fixed.
Reduced motion and the HTML fallback retain a gentle original-image crossfade,
bypassing the liquify and outward reveal.

The transparent mark is large and centered above the image. It uses `difference`
blending with an inverted ink layer so it remains readable over light and dark
artwork without an opaque card. There are no visible interface elements:
no timeline bar, headings, counters, phase labels, or buttons.

## Controls and access

- Autoplay loops endlessly: 8 seconds forward, 8 seconds backward.
  Wheel, touch, pointer press, or scrolling keys stop playback immediately and
  leave native scrolling in control. Background tabs pause without jumping ahead.
- Native keyboard scrolling, including Home/End and Page Up/Page Down, remains available.
- Reduced motion disables autoplay and uses a gentle crossfade instead of the gooey morph.
- The first paint is an HTML portrait fallback (a 31 KB derivative). The canvas
  fades in only after textures and the first frame are ready.
- If WebGL is unavailable or the context is lost, the scroll-linked HTML image
  dissolve remains usable; context restoration is attempted automatically.
  Screen-reader-only status reports unavailable imagery without adding visible
  text. Broken plates are removed rather than replaced with placeholders.
- Canvas resolution follows the viewport, caps DPR at 2 (1.75 on coarse
  pointers), and caps the backing buffer at 8.5 MP. Renders are rAF-scheduled
  only when progress, reduced-motion state, or size changes.

## Assets

Sources were copied into `public/assets` and never modified:

| File | Role |
| --- | --- |
| `portrait-source.jpg` | Original portrait, preserved byte-for-byte |
| `butterfly-source.png` | Original butterfly, preserved byte-for-byte |
| `mark-source.png` | Original foreground mark, preserved byte-for-byte |
| `portrait-hi.jpg` | 2048 px display derivative for the shader |
| `portrait-silhouette.svg` | Detail-preserving vector coverage trace used by the morph |
| `portrait-instant.jpg` | 960 px immediate HTML fallback |
| `butterfly-art.webp` | 709 px display derivative for the shader |
| `butterfly-silhouette.svg` | Hand-traced outline for the stationary morph and butterfly-centered reveal |
| `butterfly-fallback.webp` | 520 px fallback used by the HTML dissolve |
| `butterfly-surround.png` | Mirrored left-edge grain strip for the HTML background |
| `mark.png` | Transparent, trimmed, recoloured ink derivative |

`mark.png` was rebuilt from the original 834 px source: an 805 × 834 plate was
cropped from the supplied artwork, the antialiased alpha was retained so fine
strokes stay intact, the ink was set to a single near-black tone, and
transparent RGB was zeroed so filtering cannot create a white halo. It is
displayed inverted with `difference` blending, so it reads over both paper and
ink.
