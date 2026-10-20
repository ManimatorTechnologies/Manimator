// Phase 0 check: can the browser draw Manim-like frames with Canvas2D (Cairo's drawing model) and encode them
// fast enough? Draws a busy frame (a number plane, circles being drawn, filled shapes, glyph text from the DejaVu
// font), encodes it to H.264 with WebCodecs and mp4-muxer, and reports the speed and memory.

import { loadMp4Muxer, loadOpentype } from "/static/js/engine/mw/lib.js";

const FW = 128 / 9;
const FH = 8;
const log = (s) => { document.getElementById("log").textContent += `${s}\n`; };

function bezierCircle(cx, cy, r, n = 8) {
  // Manim's Circle: 8 cubic arcs with handles at 4/3 tan(theta/4)
  const pts = [];
  const step = (2 * Math.PI) / n;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < n; i += 1) {
    const a0 = i * step;
    const a1 = a0 + step;
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
    const p3 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    pts.push([p0, [p0[0] - k * r * Math.sin(a0), p0[1] + k * r * Math.cos(a0)],
      [p3[0] + k * r * Math.sin(a1), p3[1] - k * r * Math.cos(a1)], p3]);
  }
  return pts;
}

function partial(curves, a) { // the first fraction a of the curves (whole curves, plus a part of the last)
  const n = curves.length;
  const t = a * n;
  const full = Math.floor(t);
  const out = curves.slice(0, full);
  const f = t - full;
  if (full < n && f > 0) {
    const [p0, p1, p2, p3] = curves[full];
    const l = (u, v, s) => [u[0] + (v[0] - u[0]) * s, u[1] + (v[1] - u[1]) * s];
    const q0 = l(p0, p1, f); const q1 = l(p1, p2, f); const r0 = l(q0, q1, f);
    const q2 = l(p2, p3, f); const r1 = l(q1, q2, f); const s0 = l(r0, r1, f);
    out.push([p0, q0, r0, s0]);
  }
  return out;
}

function pathOf(ctx, curves) {
  if (!curves.length) return;
  ctx.moveTo(curves[0][0][0], curves[0][0][1]);
  for (const [, p1, p2, p3] of curves) ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
}

async function glyphPaths(text, size) {
  const opentype = await loadOpentype();
  const buf = await (await fetch("/static/fonts/dejavu/DejaVuSans.ttf")).arrayBuffer();
  const font = opentype.parse(buf);
  // One glyph per character with kerning (opentype.js's full shaping can't run DejaVu's contextual tables).
  const commands = [];
  let x = 0;
  let prev = null;
  const scale = size / font.unitsPerEm;
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, g) * scale;
    commands.push(...g.getPath(x, 0, size).commands);
    x += g.advanceWidth * scale;
    prev = g;
  }
  return { commands, glyphs: [...text].length };
}

function drawGlyphs(ctx, commands, x, y, s) {
  ctx.beginPath();
  for (const c of commands) {
    if (c.type === "M") ctx.moveTo(x + c.x * s, y - c.y * s);
    else if (c.type === "L") ctx.lineTo(x + c.x * s, y - c.y * s);
    else if (c.type === "Q") ctx.quadraticCurveTo(x + c.x1 * s, y - c.y1 * s, x + c.x * s, y - c.y * s);
    else if (c.type === "C") ctx.bezierCurveTo(x + c.x1 * s, y - c.y1 * s, x + c.x2 * s, y - c.y2 * s, x + c.x * s, y - c.y * s);
    else if (c.type === "Z") ctx.closePath();
  }
  ctx.fill();
}

function drawFrame(ctx, w, h, alpha, text) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(w / FW, 0, 0, -h / FH, w / 2, h / 2); // Manim's Cairo matrix: scene units, y up
  ctx.lineWidth = 2 * 0.01; // number plane lines: stroke width 2
  ctx.strokeStyle = "rgba(41,171,202,1)";
  ctx.beginPath();
  for (let x = -7; x <= 7; x += 0.5) { ctx.moveTo(x, -4); ctx.lineTo(x, 4); }
  for (let y = -4; y <= 4; y += 0.5) { ctx.moveTo(-7.2, y); ctx.lineTo(7.2, y); }
  ctx.stroke();
  ctx.lineWidth = 4 * 0.01;
  const colors = ["#FC6255", "#58C4DD", "#83C167", "#FFFF00", "#5CD0B3", "#F0AC5F", "#9A72AC", "#FF862F"];
  for (let i = 0; i < 24; i += 1) {
    const c = bezierCircle(-6 + (i % 12), i < 12 ? 1.5 : -1.5, 0.45);
    ctx.beginPath();
    pathOf(ctx, partial(c, alpha));
    ctx.strokeStyle = colors[i % 8];
    ctx.fillStyle = `${colors[i % 8]}55`;
    if (alpha > 0.99) { ctx.closePath(); ctx.fill(); }
    ctx.stroke();
  }
  ctx.fillStyle = "#FFFFFF";
  drawGlyphs(ctx, text.commands, -5 + alpha * 2, 3.2, 1);
}

async function run({ width = 1920, height = 1080, fps = 60, seconds = 5, bitrate = 10e6 } = {}) {
  const stage = document.getElementById("stage");
  stage.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = "640px";
  stage.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  const text = await glyphPaths("Manim in the browser: x² + y² = r²", 0.5);
  const { Muxer, ArrayBufferTarget } = await loadMp4Muxer();
  const codec = "avc1.640033";
  const support = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
  if (!support.supported) return { error: `encoder can't do ${codec} at ${width}x${height}` };
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width, height }, fastStart: "in-memory" });
  let failure = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  encoder.configure({ codec, width, height, bitrate, framerate: fps });
  const frames = Math.round(seconds * fps);
  let drawMs = 0;
  let waitMs = 0;
  const t0 = performance.now();
  for (let i = 0; i < frames && !failure; i += 1) {
    const d0 = performance.now();
    drawFrame(ctx, width, height, i / (frames - 1), text);
    drawMs += performance.now() - d0;
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(vf, { keyFrame: i % fps === 0 });
    vf.close();
    const w0 = performance.now();
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
    waitMs += performance.now() - w0;
  }
  await encoder.flush();
  muxer.finalize();
  const total = performance.now() - t0;
  const buffer = muxer.target.buffer;
  const bytes = new Uint8Array(buffer);
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { error: failure && String(failure), width, height, fps, frames, seconds, ms: Math.round(total),
    drawMsPerFrame: +(drawMs / frames).toFixed(2), encodeWaitMs: Math.round(waitMs), realtime: +(total / 1000 / seconds).toFixed(2),
    bytes: buffer.byteLength, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
    glyphs: text.glyphs, mp4: btoa(b64) };
}

window.harness = { run, ready: true };
log("export check ready");
