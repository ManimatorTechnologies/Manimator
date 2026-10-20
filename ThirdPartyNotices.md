# Third-party notices

Manimator's own code is under the MIT License (see `LICENSE`). These parts were
made by others and stay under their own licenses, whose full texts are in this repository:

| What | Where it is used | License | Text |
|---|---|---|---|
| [Manim](https://github.com/ManimCommunity/manim) (Copyright 2018 3Blue1Brown LLC; 2024 the Manim Community Developers) | `manimator/web/js/engine/` is a JavaScript port of parts of Manim; `manimator/registry/` holds values taken from it | MIT | `licenses/Manim3b1b.txt`, `licenses/ManimCommunity.txt` |
| [Preact](https://preactjs.com) (Copyright 2015-present Jason Miller) | `manimator/web/vendor/preact-htm.js` | MIT | `licenses/preact.txt` |
| [htm](https://github.com/developit/htm) | `manimator/web/vendor/preact-htm.js` | Apache-2.0 | `manimator/web/vendor/LICENSE-htm.txt` |
| [manim-web](https://www.npmjs.com/package/manim-web) 0.33.0 (Copyright 2025 Narek Maloyan) | `manimator/web/vendor/manim-web/` | MIT | `manimator/web/vendor/manim-web/0.33.0/LICENSE` |
| [MathJax](https://www.mathjax.org) 4 (MathJax Consortium), in manim-web's chunk, and its New Computer Modern font data | `manimator/web/vendor/manim-web/`, `manimator/web/vendor/mathjax-newcm/` | Apache-2.0 | `licenses/MathJax.txt` |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (Copyright 2023 Vanilagy), in manim-web's chunk | `manimator/web/vendor/manim-web/` | MIT | `licenses/Mp4Muxer.txt` |
| [webm-muxer](https://github.com/Vanilagy/webm-muxer) (Copyright 2022 Vanilagy), in manim-web's chunk | `manimator/web/vendor/manim-web/` | MIT | `licenses/WebmMuxer.txt` |
| [opentype.js](https://opentype.js.org) 2.0.0 (Copyright 2020 Frederik De Bleser) | `manimator/web/vendor/opentype/` | MIT | `manimator/web/vendor/opentype/2.0.0/LICENSE` |
| Fonts: CMU Serif, Crimson Pro, Gelasio, Geist, IBM Plex Sans, Inter, Lato, Source Sans 3, Source Serif 4, STIX Two Text, Tinos | `manimator/web/fonts/*/` | SIL Open Font License 1.1 | `OFL.txt` in each font's folder |
| Fonts: DejaVu | `manimator/web/fonts/dejavu/` | Bitstream Vera / Arev license (DejaVu changes are public domain) | `manimator/web/fonts/dejavu/LICENSE` |

Where each vendored package came from, and its checksum, is in the `SOURCE.md` and `SHA256SUMS` files next to it.
