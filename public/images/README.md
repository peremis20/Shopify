# Site images

Drop your image files here using the **exact filenames** below. The app
references these paths, so once a file is present it appears automatically.
Any file that's missing falls back to a branded gradient + icon (no broken
images), so you can add them one at a time.

> Tip: keep photos reasonably sized (≈100–300 KB each) so the page loads fast.
> JPGs are expected below — if you use PNG/WebP, either rename to `.jpg` or
> update the matching path (see "Where each is referenced").

## Files to add

| Filename                     | Used for                          | Suggested size (px) |
| ---------------------------- | --------------------------------- | ------------------- |
| `hero.jpg`                   | Hero image (health flat-lay)      | 1200 × 900          |
| `goal-energy-focus.jpg`      | Card: Boost Energy & Focus        | 600 × 400           |
| `goal-increase-energy.jpg`   | Card: Increase Energy             | 600 × 400           |
| `goal-better-sleep.jpg`      | Card: Better Sleep & Recovery     | 600 × 400           |
| `goal-immunity.jpg`          | Card: Strengthen Immunity         | 600 × 400           |
| `goal-digestion.jpg`         | Card: Improve Digestion           | 600 × 400           |
| `goal-heart-health.jpg`      | Card: Heart Health                | 600 × 400           |
| `goal-skin-glow.jpg`         | Card: Healthy Skin & Glow         | 600 × 400           |
| `goal-weight.jpg`            | Card: Weight Management           | 600 × 400           |
| `avatar-1.jpg` … `avatar-4.jpg` | Trust-bar customer thumbnails  | 80 × 80 (square)    |
| `logo.png` *(optional)*      | Brand logo in the navbar          | transparent PNG     |

## Where each is referenced

- Goal card photos → `src/lib/quiz-data.ts` (the `photo:` field on each goal)
- Hero photo → `src/components/Hero.tsx`
- Avatars → `src/components/TrustBar.tsx`
- Logo → `src/components/Logo.tsx` (uses `logo.png` if present, else the
  text logo)

To use different filenames or formats, just edit the paths in those files.
