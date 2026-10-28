// Running a Python Manim script in the browser: Pyodide runs the script, and the `manim` module it imports
// (code/manim.py) hands every object, animation and self.play to the browser engine. Each frame Manim would write
// is drawn into a Recorder as the script plays, so the video can be shown and scrubbed after the script ends.
//
//   const py = await loadPython({ onOutput });
//   const result = await py.run(code);   // { frames: [{ ops, count }], fps, width, height, scene, error }

import * as API from "../engine/KitApi.js";
import { ANIMATIONS, AnimationBuilder } from "../engine/anim/index.js";
import { Animation } from "../engine/anim/animation.js";
import { config, setQuality } from "../engine/manim/config.js";
import { Mobject } from "../engine/manim/mobject.js";
import { callMethod } from "../engine/manim/pymethods.js";
import { pyCall } from "../engine/manim/pycall.js";
import { clearTexRequests, hasTexRequests, renderTexRequests } from "../engine/manim/texcache.js";
import { CLASSES } from "../engine/plan/names.js";
import { RATE_FUNCTIONS } from "../engine/core/rates.js";
import { SCENE_KINDS } from "../engine/scene/kinds.js";
import { SCENE_METHODS } from "../engine/scene/scene.js";
import { callSceneMethod } from "../engine/scene/timeline.js";
import { Recorder } from "./Recorder.js";

export const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const HOME = "/home/pyodide"; // the script's folder: its data files are here
const PASSES = 4; // runs of the script while it makes formulas that aren't rendered yet

const isNumbers = (v, depth = 0) => (Array.isArray(v) || ArrayBuffer.isView(v))
  && v.length > 0 && depth < 3 && Array.from(v).every((x) => typeof x === "number" || isNumbers(x, depth + 1));
const plain = (v) => Array.from(v, (x) => (typeof x === "number" ? x : plain(x)));
const isStarted = (v) => v && typeof v === "object" && typeof v.script?.next === "function";

/** The engine as code/manim.py sees it (the "_manimator" module). `runs.current`: the run in progress. */
function makeBridge(runs) {
  const ids = new WeakMap();
  let nextId = 1;
  const parentName = (C) => {
    for (let P = Object.getPrototypeOf(C); P && P !== Function.prototype; P = Object.getPrototypeOf(P)) {
      if (CLASSES[P.name] === P || ANIMATIONS[P.name] === P) return P.name;
    }
    return null;
  };
  return {
    classes: () => Object.keys(CLASSES).map((n) => [n, parentName(CLASSES[n])]),
    animations: () => Object.keys(ANIMATIONS).map((n) => [n, parentName(ANIMATIONS[n])]),
    sceneKinds: () => Object.keys(SCENE_KINDS),
    constants: () => Object.entries(API).filter(([n, v]) => !(n in CLASSES) && !(n in ANIMATIONS)
      && (typeof v !== "function" || RATE_FUNCTIONS[n] === v)).map(([n]) => n),
    constant: (name) => API[name],
    make: (name, args, kwargs) => pyCall(CLASSES[name] ?? ANIMATIONS[name], args, kwargs),
    call: (obj, name, args, kwargs) => callMethod(obj, name, args, kwargs),
    attrKind: (obj, name) => (!(name in obj) ? "missing" : typeof obj[name] === "function" ? "method" : "value"),
    get: (obj, name) => obj[name],
    set: (obj, name, value) => { obj[name] = value; },
    has: (obj, name) => name in obj,
    id: (obj) => {
      if (!ids.has(obj)) ids.set(obj, nextId++);
      return ids.get(obj);
    },
    kind: (v) => {
      if (v instanceof Mobject) return "mobject";
      if (v instanceof Animation) return "animation";
      if (v instanceof AnimationBuilder) return "builder";
      if (isNumbers(v)) return "numbers";
      if (Array.isArray(v)) return "array";
      return "other";
    },
    numbers: (v) => plain(v),
    className: (obj) => {
      for (let C = obj.constructor; C && C !== Object; C = Object.getPrototypeOf(C)) {
        if (CLASSES[C.name] === C || ANIMATIONS[C.name] === C) return C.name;
      }
      return null;
    },
    animate: (mob) => new AnimationBuilder(mob),
    builderArgs: (b, kwargs) => b.withArgs(kwargs),
    builderCall: (b, name, args, kwargs) => b.call(name, args, kwargs),
    /** A Python callable as the engine calls it; `takesDt`: an updater with a dt parameter. */
    fn: (py, takesDt) => {
      const f = (...args) => py(...args);
      if (takesDt !== null) f.takesDt = takesDt;
      return f;
    },
    array: () => [],
    object: () => ({}),
    newScene: (kind) => runs.current.newScene(kind),
    scene: (name, args, kwargs) => runs.current.sceneCall(name, args, kwargs),
    sceneAttr: (name) => runs.current.scene[name],
    sceneAttrKind: (name) => {
      const { scene } = runs.current;
      return (scene.constructor.METHODS?.[name] ?? SCENE_METHODS[name]) ? "method" : name in scene ? "value" : "missing";
    },
    print: (text, stream) => runs.current.onOutput(text, stream),
  };
}

/** One run of a script: the scene its code plays and the frames it made. */
class Run {
  constructor(onOutput) {
    this.onOutput = onOutput;
    this.scene = null;
    this.frames = [];
  }

  newScene(kind) {
    const Kind = SCENE_KINDS[kind] ?? SCENE_KINDS.Scene;
    this.scene = new Kind();
    this.scene.setup();
    this.frames = [];
    return this.scene;
  }

  sceneCall(name, args, kwargs) {
    const { scene } = this;
    let result = callSceneMethod(scene, name, args, kwargs);
    if (isStarted(result)) {
      // a scene method that plays (move_camera...): each of its plays in turn
      const { script } = result;
      for (;;) {
        if (scene.playing) this.playThrough();
        if (script.next().done) break;
      }
      result = undefined;
    } else if (scene.playing) {
      this.playThrough();
    }
    return result;
  }

  /** Every frame of the play in progress, as Manim writes them (Timeline.frames), then its end. */
  playThrough() {
    const { scene } = this;
    const dt = 1 / config.frame_rate;
    if (scene.playing.frozen) {
      this.record(Math.trunc(scene.duration / dt));
    } else {
      const n = Math.ceil(scene.duration / dt);
      for (let i = 0; i < n; i += 1) {
        scene.update_to_time(i * dt);
        this.record(1);
      }
    }
    scene.finish_play();
  }

  record(count) {
    const rec = new Recorder();
    this.scene.camera.pixel_width = config.pixel_width;
    this.scene.camera.pixel_height = config.pixel_height;
    this.scene.render(rec);
    this.frames.push({ ops: rec.ops, count });
  }
}

let loading = null;

/** Loads Pyodide (once), numpy and the `manim` module. `onOutput(text, stream)` gets print() and errors. */
export function loadPython({ onOutput = () => {}, manimUrl = new URL("./manim.py", import.meta.url).href } = {}) {
  loading ??= (async () => {
    const { loadPyodide } = await import(`${PYODIDE}pyodide.mjs`);
    const pyodide = await loadPyodide({ indexURL: PYODIDE });
    await pyodide.loadPackage("numpy");
    const source = await (await fetch(manimUrl)).text();
    pyodide.FS.mkdirTree("/lib/manimator/manim");
    pyodide.FS.writeFile("/lib/manimator/manim/__init__.py", source);
    pyodide.runPython("import sys; sys.path.insert(0, '/lib/manimator')");
    const runs = { current: null };
    pyodide.registerJsModule("_manimator", makeBridge(runs));
    return { pyodide, runs };
  })();
  return loading.then(({ pyodide, runs }) => new PythonRunner(pyodide, runs, onOutput));
}

class PythonRunner {
  constructor(pyodide, runs, onOutput) {
    this.pyodide = pyodide;
    this.runs = runs;
    this.onOutput = onOutput;
    this.files = new Set(); // data files written for the script
  }

  /** Makes the script's data files exactly `files` ({name: Uint8Array}), opened by name from its folder. */
  setFiles(files) {
    const { FS } = this.pyodide;
    FS.mkdirTree(HOME);
    for (const name of this.files) {
      if (!(name in files)) {
        try { FS.unlink(`${HOME}/${name}`); } catch { /* already gone */ }
      }
    }
    for (const [name, data] of Object.entries(files)) FS.writeFile(`${HOME}/${name}`, data);
    this.files = new Set(Object.keys(files));
  }

  /** Runs `code` and plays its scene (`sceneName`, or the first Scene class it defines) at quality `q`. */
  async run(code, { sceneName = null, q = "l" } = {}) {
    setQuality(q);
    const t0 = performance.now();
    let run;
    let error = null;
    for (let pass = 0; pass < PASSES; pass += 1) {
      clearTexRequests();
      run = new Run(pass === 0 ? this.onOutput : () => {}); // print() output once, from the first pass
      this.runs.current = run;
      const runner = this.pyodide.runPython("import manim; manim._run");
      try {
        error = runner(code, sceneName) ?? null;
      } catch (e) {
        error = String(e?.message ?? e);
      } finally {
        runner.destroy();
      }
      if (!hasTexRequests()) break;
      await renderTexRequests();
    }
    if (!run.frames.length && run.scene) run.record(config.frame_rate); // nothing played: a 1 s still of the scene
    if (error) this.onOutput(error, "error");
    const names = this.pyodide.runPython("import manim; manim._scene_names");
    const scenes = names.toJs();
    names.destroy();
    return {
      frames: run.frames,
      fps: config.frame_rate,
      width: config.pixel_width,
      height: config.pixel_height,
      scenes,
      scene: sceneName && scenes.includes(sceneName) ? sceneName : scenes[0] ?? null,
      error,
      ms: performance.now() - t0,
    };
  }
}
