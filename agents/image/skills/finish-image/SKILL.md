---
name: finish-image
description: Make an image publish-ready with tools/finish.py — exact platform sizes, crop or letterbox, WebP/AVIF/JPG, file-size targets, exact text on top, contact sheets.
---

# Finish an image

Tool: `uv run <pkg>/tools/finish.py` (Pillow via uv; first run fetches it once). It never overwrites
(OUT becomes OUT-v2…) and prints one JSON line per file. Generation is creative; this step is deterministic.

```
finish.py presets                                     # og 1200x630, x-card, blog-hero, yt-thumb, ig-square,
                                                      # ig-portrait, story, linkedin-*, gh-social, readme-tile
finish.py fit IMG --preset og --out x.webp --max-kb 200 [--gravity top|bottom|left|right]
finish.py fit IMG --size 1080x1080 --contain --bg "#eef0ec" --out x.png    # letterbox, nothing cropped
finish.py text IMG --out x.png --title "Exact headline" --sub "Second line" --pos bottom-left --scrim
finish.py sheet a.png b.png c.png --labels --out compare.jpg               # show variants side by side
finish.py info IMG...                                 # size, alpha, KB
```

## Rules
- **Exact words go on with `text`, not in the prompt.** Generated text can be misspelled or rewritten, so for
  headlines, names, prices, dates and anything legal, generate the image with empty space for the text ("leave
  the lower third calm and empty for a headline"), then add the words with `text`. Short decorative words inside
  an illustration can stay generated; read them letter by letter.
- **Plan the crop before generating.** Square outputs lose a lot when cropped to 1200x630. For a wide asset, ask
  for "wide 16:9" in the prompt, then `fit` with the right `--gravity`. Look at the crop; move the gravity if a
  hand, face or the subject is cut off.
- Formats: web → `.webp` (or `.avif` for the smallest file); anything with transparency → `.png` or `.webp`;
  email or old tools → `.jpg`. OG images: 1200x630, under ~300 KB, no important content within 60 px of the
  edges. Use `--max-kb` to hit size limits.
- `fit` warns when it upscales a small source; say so if it shows.
- Use `--font` with a brand font file when the project has one (check the brand folder); the default is SF/Helvetica.
- Look at every output before handing it over.
