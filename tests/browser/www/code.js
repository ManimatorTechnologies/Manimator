// Code test page: a Python Manim script run with Pyodide, drawn by the browser engine (web/js/code/).

import { loadPython } from "/static/js/code/PyBridge.js";
import { replay } from "/static/js/code/Recorder.js";
import { loadFonts } from "/static/js/engine/manim/fonts.js";
import { loadOpentype } from "/static/js/engine/mw/lib.js";

const $ = (id) => document.getElementById(id);
const out = $("console");

const SAMPLE = `from manim import *

class Demo(Scene):
    def construct(self):
        title = Text("Hello from Python").to_edge(UP)
        circle = Circle(radius=1.5, color=BLUE)
        self.play(Write(title), Create(circle))
        self.play(circle.animate.shift(LEFT * 3).scale(0.5))

        data = np.loadtxt("data.csv", delimiter=",") if __import__("os").path.exists("data.csv") else np.array([1, 3, 2, 5, 4])
        print("data:", data)
        bars = VGroup(*[Rectangle(width=0.5, height=v * 0.6).set_fill(TEAL, 0.8) for v in data])
        bars.arrange(RIGHT, buff=0.2, aligned_edge=DOWN).shift(RIGHT * 1.5 + DOWN)
        self.play(LaggedStart(*[GrowFromEdge(b, DOWN) for b in bars], lag_ratio=0.2))

        formula = MathTex(r"\\sum_{i} x_i = " + f"{data.sum():g}").next_to(bars, UP)
        self.play(FadeIn(formula, shift=UP))
        dot = Dot(color=YELLOW).move_to(circle.get_right())
        dot.add_updater(lambda m, dt: m.rotate(dt * PI, about_point=circle.get_center()))
        self.add(dot)
        self.wait(2)
`;

$("code").value = SAMPLE;

function log(text, cls = "") {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text.endsWith("\n") || cls === "" ? text : `${text}\n`;
  out.append(span);
  out.scrollTop = out.scrollHeight;
}

// ---- the player: the recorded frames, each shown `count` times
let video = null; // { frames, fps, width, height, at: [frame index for each video frame] }
let frame = 0;
let playing = false;
const screen = $("screen");
const ctx = screen.getContext("2d");

function show(i) {
  if (!video || !video.at.length) return;
  frame = Math.max(0, Math.min(video.at.length - 1, i));
  replay(video.frames[video.at[frame]].ops, ctx, screen.width / video.width);
  $("scrub").value = frame;
  $("time").textContent = `${(frame / video.fps).toFixed(1)} s`;
}

function play() {
  if (!video) return;
  if (frame >= video.at.length - 1) frame = 0;
  playing = true;
  $("play").textContent = "❚❚";
  const start = performance.now() - (frame / video.fps) * 1000;
  const tick = () => {
    if (!playing) return;
    const i = Math.floor(((performance.now() - start) / 1000) * video.fps);
    show(i);
    if (i >= video.at.length - 1) stop();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stop() {
  playing = false;
  $("play").textContent = "▶";
}

$("play").onclick = () => (playing ? stop() : play());
$("scrub").oninput = (e) => {
  stop();
  show(Number(e.target.value));
};

// ---- running
const status = $("status");
await loadFonts("/static/fonts", await loadOpentype());
const t0 = performance.now();
const py = await loadPython({ onOutput: (text, stream) => log(text, stream === "out" ? "" : "err") });
status.textContent = `Python ready (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
$("run").disabled = false;

async function run() {
  stop();
  $("run").disabled = true;
  out.textContent = "";
  status.textContent = "Running…";
  await new Promise((r) => setTimeout(r, 0));
  try {
    const result = await py.run($("code").value);
    const at = [];
    result.frames.forEach((f, i) => { for (let k = 0; k < f.count; k += 1) at.push(i); });
    video = { ...result, at };
    $("scrub").max = Math.max(0, at.length - 1);
    log(`Ran in ${(result.ms / 1000).toFixed(2)} s: ${at.length} frames, ${(at.length / result.fps).toFixed(1)} s of video`, "info");
    status.textContent = result.error ? "Error" : "Done";
    show(0);
    if (!result.error) play();
  } catch (e) {
    log(String(e?.stack ?? e), "err");
    status.textContent = "Error";
  } finally {
    $("run").disabled = false;
  }
}

$("run").onclick = run;
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    run();
  }
});
$("code").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  e.target.setRangeText("    ", e.target.selectionStart, e.target.selectionEnd, "end");
});

// ---- data files
const dataFiles = {};
async function addFiles(files) {
  for (const file of files) {
    dataFiles[file.name] = new Uint8Array(await file.arrayBuffer());
    py.setFiles(dataFiles);
    const row = document.createElement("div");
    row.className = "f";
    row.textContent = file.name;
    $("drop").before(row);
    log(`Added ${file.name} (${file.size} bytes)`, "info");
  }
}
$("upload").onclick = () => $("pick").click();
$("pick").onchange = (e) => addFiles(e.target.files);
$("drop").ondragover = (e) => e.preventDefault();
$("drop").ondrop = (e) => {
  e.preventDefault();
  addFiles(e.dataTransfer.files);
};

window.codeTest = { run, py, get video() { return video; }, show };
