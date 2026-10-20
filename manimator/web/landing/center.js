// The home and pricing pages' buttons, centred for the eye. A button's words and arrow are centred by what they
// draw, not by their boxes (letters and icons carry empty space around them): left to right the ink of the words
// and the arrow, with GAP between them, sits in the middle. Top to bottom the words sit by the weight of their ink
// between the capitals' tops and the baseline (descenders left out, as the eye does): mostly small letters weigh
// below the capitals' middle, so centring only the capitals looks low. The arrow sits on the middle of the small
// letters, where fonts put their own arrow (→). Like the app's centerText (js/ui.js), for these pages' own buttons.
//
// Kept apart from landing.js, which can't run until the whole animation engine has loaded, and loaded with
// blocking="render" (index.html): the page is first painted with the buttons already in place, not moved later.
const GAP = 8; // px of empty space between the last letter and the arrow
const NUDGE = 1; // px the arrow then moves right, the words staying put: chosen by eye
const ARROW = { left: 5, right: 19, top: 6, bottom: 18 }; // the arrow's strokes in its 24-unit box, before line width
/** Empty space before the first and after the last letter (side bearings), in px: `text` drawn as the page draws
 *  it (at the screen's pixel ratio, so fitted to the same pixel grid) and its pixels scanned, partly covered edge
 *  columns counting by how much they are covered. Canvas text metrics are too coarse for this. */
function textInk(text, font, size, spacing, scale) {
  const fs = size * scale;
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  const setFont = () => { ctx.font = font.replace(/[\d.]+px/, `${fs}px`); ctx.letterSpacing = `${spacing * scale}px`; };
  setFont();
  const adv = ctx.measureText(text).width;
  cv.width = Math.ceil(adv + fs);
  cv.height = Math.ceil(fs * 2);
  setFont(); // resizing the canvas reset it
  const ox = Math.ceil(fs / 2);
  ctx.fillText(text, ox, Math.ceil(fs * 1.4));
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const cover = (x) => {
    let most = 0;
    for (let y = 0; y < cv.height; y++) most = Math.max(most, d[(y * cv.width + x) * 4 + 3]);
    return most / 255;
  };
  let x0 = 0, x1 = cv.width - 1;
  while (x0 < x1 && cover(x0) < 0.02) x0++;
  while (x1 > x0 && cover(x1) < 0.02) x1--;
  return { lead: (x0 + 1 - cover(x0) - ox) / scale, trail: (ox + adv - (x1 + cover(x1))) / scale };
}

/** `text` drawn at the real pixel size (small text is fitted to the pixel grid, which can make it shorter than the
 *  font says), row by row up from the baseline: `h` the row's middle above the baseline in device px, `most` how
 *  much of the row is covered somewhere, `sum` how much ink the row holds. */
function inkRows(text, font, size, dpr) {
  const fs = size * dpr, base = Math.ceil(fs * 2);
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  const setFont = () => { ctx.font = font.replace(/[\d.]+px/, `${fs}px`); };
  setFont();
  cv.width = Math.ceil(ctx.measureText(text).width + fs);
  cv.height = base + Math.ceil(fs);
  setFont(); // resizing the canvas reset it
  ctx.fillText(text, Math.ceil(fs / 2), base);
  const d = ctx.getImageData(0, 0, cv.width, base).data;
  const rows = [];
  for (let y = 0; y < base; y++) {
    let most = 0, sum = 0;
    for (let x = 0; x < cv.width; x++) {
      const a = d[(y * cv.width + x) * 4 + 3] / 255;
      most = Math.max(most, a);
      sum += a;
    }
    rows.push({ h: base - y - 0.5, most, sum });
  }
  return rows;
}

/** How tall `letter` is drawn on this screen, in px ("H": the capitals, "x": the small letters). */
const letterHeight = (letter, font, size, dpr) => inkRows(letter, font, size, dpr).reduce((n, r) => n + r.most, 0) / dpr;

/** Where the weight of `text`'s ink sits above the baseline, in px, counting only what lies between the capitals'
 *  tops and the baseline (ascenders above the capitals and descenders are left out). */
function inkMiddle(text, font, size, dpr, cap) {
  let at = 0, ink = 0;
  for (const r of inkRows(text, font, size, dpr)) {
    if (r.h <= 0 || r.h >= cap * dpr) continue;
    at += r.h * r.sum;
    ink += r.sum;
  }
  return ink ? at / ink / dpr : cap / 2;
}

function centerButton(btn) {
  const label = btn.querySelector("span"), icon = btn.querySelector("svg"), path = icon?.querySelector("path");
  if (!label) return;
  label.style.transform = "";
  path?.removeAttribute("transform");
  const b = btn.getBoundingClientRect(), s = label.getBoundingClientRect();
  if (!b.width) return;
  const dpr = window.devicePixelRatio || 1, snap = (v) => Math.round(v * dpr) / dpr;
  const cs = getComputedStyle(label);
  const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, size = parseFloat(cs.fontSize);
  const ink = textInk(label.textContent, font, size, parseFloat(cs.letterSpacing) || 0, dpr);
  const inkLeft = s.left + ink.lead, inkRight = s.right - ink.trail;
  const cap = letterHeight("H", font, size, dpr), small = letterHeight("x", font, size, dpr);
  const weight = inkMiddle(label.textContent, font, size, dpr, cap);
  const probe = document.createElement("span"); // a 0-high box on the baseline: where the page draws it
  probe.style.cssText = "display:inline-block; width:0; height:0; vertical-align:baseline";
  label.appendChild(probe);
  const baseline = snap(probe.getBoundingClientRect().top); // letters are drawn on whole device px up and down
  probe.remove();
  const mid = b.top + b.height / 2;
  // letters move exactly across but by whole device px up and down; the arrow can move by any fraction
  const textDy = snap(mid - (baseline - weight));
  if (!path) { // words only (the pricing page's buttons)
    const dx = b.left + (b.width - (inkRight - inkLeft)) / 2 - inkLeft;
    label.style.transform = `translate(${dx.toFixed(3)}px, ${textDy.toFixed(3)}px)`;
    return;
  }
  const a = icon.getBoundingClientRect();
  // the icon is painted at its box snapped to whole CSS px; its strokes are 1.6 units wide
  const unit = a.width / 24, half = (parseFloat(getComputedStyle(path).strokeWidth) || 1.6) / 2;
  const ax0 = Math.round(a.left) + (ARROW.left - half) * unit, ax1 = Math.round(a.left) + (ARROW.right + half) * unit;
  const amid = Math.round(a.top) + ((ARROW.top + ARROW.bottom) / 2) * unit;
  const width = inkRight - inkLeft + GAP + (ax1 - ax0);
  const start = b.left + (b.width - width) / 2;
  label.style.transform = `translate(${(start - inkLeft).toFixed(3)}px, ${textDy.toFixed(3)}px)`;
  const arrowDx = start + (inkRight - inkLeft) + GAP + NUDGE - ax0;
  const smallMid = baseline + textDy - small / 2; // where the letters landed: the arrow lines up with them, not the middle
  path.setAttribute("transform", `translate(${(arrowDx / unit).toFixed(3)} ${((smallMid - amid) / unit).toFixed(3)})`);
}

const centerAll = () => document.querySelectorAll(".lp-btn").forEach(centerButton);
// now, before the first paint (the page's HTML has been read by the time a module runs); then again whenever
// anything could have moved them: the page's size, fonts arriving, the page finishing loading. Straight away each
// time, not a frame later, so no frame is painted with them out of place (moving them changes no sizes, so the
// ResizeObserver isn't set off again).
centerAll();
new ResizeObserver(centerAll).observe(document.body);
document.fonts?.ready.then(centerAll);
window.addEventListener("load", centerAll);
window.addEventListener("resize", centerAll);
