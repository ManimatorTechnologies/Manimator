// A scene plan played on the port of Manim: the scene (of the plan's kind) made and set up, its starting objects,
// then each step's statements (self.play, self.wait, self.move_camera...) as the generated Python runs them, with
// any moment of it reachable by seek(t), and every frame Manim would write by frames().
//
// A step's plays: most steps play once. A scene method that plays several times (vector_to_coords) or does
// something after its play (move_camera) is a generator (kinds.js); the step goes through its plays in turn.
//
// Seeking forward runs the steps in between; seeking backward starts again from a copy of the scene taken when the
// step began (taken the first time it is passed). Built objects are copied for each run, never changed.
//
// Formulas a step makes as it plays (vector_to_coords's coordinates...) are rendered beforehand: prepare() runs the
// whole video once, renders what was missing, and runs it again (MathJax is asynchronous, the scene isn't).
//
// Manim moves an animation through every frame in turn, and some depend on that (a Succession only moves on;
// a group's parts clip differently when time goes back): for those, seeking visits the frames in between too, at
// config.frame_rate.

import { config } from "../manim/config.js";
import { clearTexRequests, hasTexRequests, renderTexRequests } from "../manim/texcache.js";
import { deepCopy } from "../manim/mobject.js";
import { callMethod } from "../manim/pymethods.js";
import { pyCall } from "../manim/pycall.js";
import { ANIMATIONS, AnimationBuilder } from "../anim/index.js";
import { AnimationGroup } from "../anim/composition.js";
import { VMobject } from "../manim/vmobject.js";
import { evalNode } from "../plan/values.js";
import { SCENE_KINDS } from "./kinds.js";
import { SCENE_METHODS, Scene } from "./scene.js";

const GHOST_FADE = 0.75; // the layout draws objects that only appear later at 25% opacity
const SNAPSHOTS = 32;

/** A scene method (a generator) that has started a play: the timeline resumes it when that play ends. */
class Started {
  constructor(script) {
    this.script = script;
  }
}

const isGenerator = (v) => v && typeof v.next === "function" && typeof v[Symbol.iterator] === "function";

/** Calls a scene method the way Python would: positional and keyword arguments by the method's parameters. A
 *  method that is a generator runs up to its first play: its value if it never plays, else a Started. */
export function callSceneMethod(scene, name, args = [], kwargs = {}) {
  const entry = scene.constructor.METHODS?.[name] ?? SCENE_METHODS[name];
  if (!entry) throw new Error(`'${scene.constructor.name}' object has no attribute '${name}'`);
  const [params, fn] = entry;
  const named = {};
  let i = 0;
  const rest = { ...kwargs };
  for (const p of params) {
    if (p.startsWith("*")) {
      named[p.slice(1)] = args.slice(i);
      i = args.length;
      break;
    }
    if (i < args.length) named[p] = args[i++];
    else if (p in rest) {
      named[p] = rest[p];
      delete rest[p];
    }
  }
  if (i < args.length) throw new TypeError(`${name}() got too many positional arguments`);
  const result = fn(scene, named, rest);
  if (!isGenerator(result)) return result;
  const first = result.next();
  return first.done ? first.value : new Started(result);
}

/** Python's list methods, for the scene's lists (self.moving_vectors.remove(v)...). */
const LIST_METHODS = {
  append: (l, [x]) => { l.push(x); },
  extend: (l, [xs]) => { l.push(...xs); },
  insert: (l, [i, x]) => { l.splice(i < 0 ? Math.max(0, l.length + i) : i, 0, x); },
  remove: (l, [x]) => {
    const i = l.indexOf(x);
    if (i < 0) throw new Error("list.remove(x): x not in list");
    l.splice(i, 1);
  },
  pop: (l, [i = -1]) => {
    if (!l.length) throw new Error("pop from empty list");
    return l.splice(i < 0 ? l.length + i : i, 1)[0];
  },
  clear: (l) => { l.length = 0; },
  index: (l, [x]) => {
    const i = l.indexOf(x);
    if (i < 0) throw new Error("x not in list");
    return i;
  },
  count: (l, [x]) => l.filter((y) => y === x).length,
};

function callListMethod(list, name, args, kwargs) {
  const fn = LIST_METHODS[name];
  if (!fn || Object.keys(kwargs).length) throw new Error(`'list' object has no attribute '${name}'`);
  return fn(list, args);
}

/** Resolves "self", "self.camera.frame"... on the scene. */
function resolveAttr(scene, path) {
  const parts = path.split(".");
  if (parts[0] !== "self") throw new Error(`name '${parts[0]}' is not defined`);
  let value = scene;
  for (const part of parts.slice(1)) {
    if (value === null || value === undefined || !(part in value)) throw new Error(`'${value?.constructor?.name}' object has no attribute '${part}'`);
    value = value[part];
  }
  return value;
}

/** Whether a play's animations depend on seeing every frame in turn. */
function needsFrames(scene) {
  return (scene.animations ?? []).some((a) => a instanceof AnimationGroup)
    || scene.get_mobject_family_members().some((m) => m.has_time_based_updater());
}

/** The plan's scene kind, made with its settings and set up (Scene.setup, as Manim's render() does first). */
export function makeScene(plan, evaluate) {
  const Kind = SCENE_KINDS[plan.scene?.kind] ?? Scene;
  const init = Object.fromEntries(Object.entries(plan.scene?.init ?? {}).map(([k, v]) => [k, evaluate(v)]));
  const scene = new Kind(init);
  scene.setup();
  return scene;
}

export class Timeline {
  /** plan: the scene plan; built: Map id -> {mobject, error} (the built objects, never changed here). */
  constructor(plan, built) {
    this.plan = plan;
    this.built = built;
    this.errors = {}; // step index -> what went wrong
    let start = 0;
    this.steps = (plan.steps ?? []).map((step, index) => {
      const s = { ...step, index, start };
      start += step.run_time;
      return s;
    });
    this.duration = start;
    this.snapshots = new Map(); // step index -> world before that step began
    this.world = null;
    this.setupError = null;
  }

  // ------------------------------------------------------------------------------------------ running statements

  context(world) {
    return {
      ref: (id) => {
        const mob = world.objects.get(id);
        if (!mob) throw new Error(`object ${id} isn't built`);
        return mob;
      },
      attr: (path) => resolveAttr(world.scene, path),
      method: (target, name, args, kwargs) => {
        if (target instanceof Scene) return callSceneMethod(target, name, args, kwargs);
        if (Array.isArray(target)) return callListMethod(target, name, args, kwargs);
        return callMethod(target, name, args, kwargs);
      },
      call: (name, args, kwargs) => {
        const Cls = ANIMATIONS[name];
        if (!Cls) throw new Error(`name '${name}' is not defined`);
        return pyCall(Cls, args, kwargs);
      },
      animate: (target, calls, scope) => {
        const builder = new AnimationBuilder(target);
        const ctx = this.context(world);
        for (const c of calls) {
          const args = (c.args ?? []).map((a) => evalNode(a, ctx, scope));
          const kwargs = Object.fromEntries(Object.entries(c.kwargs ?? {}).map(([k, v]) => [k, evalNode(v, ctx, scope)]));
          builder.call(c.call, args, kwargs);
        }
        return builder;
      },
    };
  }

  /** Runs a statement. Returns a Started when it started a play that a scene method goes on from. */
  run(world, statement) {
    const ctx = this.context(world);
    if ("do" in statement) return evalNode(statement.do, ctx, {});
    if ("set" in statement) {
      const path = statement.set.split(".");
      const owner = resolveAttr(world.scene, path.slice(0, -1).join("."));
      owner[path[path.length - 1]] = evalNode(statement.value, ctx, {});
      return undefined;
    }
    throw new Error(`unknown statement ${JSON.stringify(statement).slice(0, 80)}`);
  }

  /** Runs a statement outside the video's steps (setup, adds): any play it makes ends at once. */
  runNow(world, statement) {
    const result = this.run(world, statement);
    const { scene } = world;
    if (result instanceof Started) {
      for (;;) {
        scene.finish_play();
        if (result.script.next().done) break;
      }
    } else if (scene.playing) {
      scene.finish_play();
    }
  }

  /** A new world: copies of the built objects, the scene made and set up, nothing added yet. */
  freshWorld() {
    const memo = new Map();
    const objects = new Map();
    // an object that failed is an empty VMobject, as in the generated Python
    for (const [id, entry] of this.built) objects.set(id, entry.mobject ? deepCopy(entry.mobject, memo) : VMobject.make());
    const world = { scene: null, objects, done: 0, active: null, local: 0, script: null, subStart: 0, subLocal: 0 };
    const ctx = this.context(world);
    world.scene = makeScene(this.plan, (node) => evalNode(node, ctx, {}));
    world.scene.camera.background_color = this.plan.background ?? world.scene.camera.background_color;
    this.setupError = null;
    for (const statement of this.plan.setup ?? []) {
      try {
        this.runNow(world, statement);
      } catch (e) {
        this.setupError ??= `Scene setup failed: ${e?.message ?? e}`;
      }
    }
    return world;
  }

  /** The world at the start of the video: set up, the starting objects added. */
  startWorld() {
    const world = this.freshWorld();
    for (const statement of this.plan.add ?? []) {
      try {
        this.runNow(world, statement);
      } catch {
        // an object that failed isn't added
      }
    }
    return world;
  }

  beginStep(world, index) {
    const step = this.steps[index];
    const at = step.play ?? 0;
    const { scene } = world;
    for (const st of step.statements.slice(0, at)) this.tryRun(world, st, index, true);
    world.script = null;
    const result = this.tryRun(world, step.statements[at], index, false);
    if (result instanceof Started) world.script = result.script;
    if (!scene.playing) {
      // the step failed (or didn't play): it holds the picture for its length instead
      scene.playing = { frozen: true, static: null, failed: true };
      world.script = null;
    }
    world.active = index;
    world.local = 0;
    world.subStart = 0;
    world.subLocal = 0;
    world.frameByFrame = needsFrames(scene);
    scene.update_to_time(0);
  }

  /** Ends the play in progress and resumes the step's scene method: true when it started another play. */
  nextPlay(world) {
    const { scene } = world;
    const d = scene.duration;
    if (world.frameByFrame && scene.playing && !scene.playing.frozen) {
      // Manim's last frame of the play comes before it ends: what moves with time moves that far, frame by frame
      const dt = 1 / config.frame_rate;
      const last = (Math.ceil(d / dt) - 1) * dt;
      for (let i = Math.floor(world.subLocal / dt) + 1; i * dt <= last; i += 1) if (i * dt > world.subLocal) scene.update_to_time(i * dt);
    }
    scene.finish_play();
    world.subStart += d;
    world.subLocal = 0;
    if (!world.script) return false;
    let r;
    try {
      r = world.script.next();
    } catch (e) {
      this.errors[world.active] ??= e?.message ?? String(e);
      r = { done: true };
    }
    if (r.done || !scene.playing) {
      world.script = null;
      return false;
    }
    world.frameByFrame = needsFrames(scene);
    scene.update_to_time(0);
    return true;
  }

  finishStep(world) {
    const index = world.active;
    const step = this.steps[index];
    const { scene } = world;
    if (scene.playing?.failed) scene.playing = null;
    else if (scene.playing) while (this.nextPlay(world)) { /* the method's remaining plays end at once */ }
    world.script = null;
    for (const st of step.statements.slice((step.play ?? 0) + 1)) this.tryRun(world, st, index, true);
    world.active = null;
    world.done = index + 1;
  }

  /** Runs a statement of step `index`, keeping its first error. `now`: plays end at once. */
  tryRun(world, statement, index, now) {
    if (!statement) return undefined;
    try {
      if (now) return this.runNow(world, statement);
      return this.run(world, statement);
    } catch (e) {
      this.errors[index] ??= e?.message ?? String(e);
      return undefined;
    }
  }

  // ------------------------------------------------------------------------------------------ formulas

  /** Runs the scene's setup (and with `all`, the whole video) until every formula they make is rendered. */
  async prepare({ all = true, passes = 4 } = {}) {
    for (let i = 0; i < passes; i += 1) {
      clearTexRequests();
      this.snapshots.clear();
      this.world = null;
      this.errors = {};
      this.layoutWorld();
      if (all) this.goto(this.steps.length);
      if (!hasTexRequests()) break;
      await renderTexRequests();
    }
    this.snapshots.clear();
    this.world = null;
    if (all) this.prepared = true;
  }

  // ------------------------------------------------------------------------------------------ seeking

  /** The step playing at `t` and the time into it; past the end: [steps.length, 0]. */
  stepAt(t) {
    for (const step of this.steps) {
      if (t < step.start + step.run_time && step.run_time > 0) return [step.index, Math.max(0, t - step.start)];
    }
    return [this.steps.length, 0];
  }

  /** Makes the world the scene at `t` seconds (0 <= t <= duration; at the end, after the last step). */
  seek(t) {
    const [index, local] = this.stepAt(Math.max(0, t));
    this.goto(index, local);
  }

  /** The world in step `index`, `local` seconds into it (index = steps.length: after every step). */
  goto(index, local = 0) {
    let w = this.world;
    // can the world get there by going forward?
    const forward = w && (w.active !== null
      ? w.active < index || (w.active === index && local >= w.local)
      : w.done <= index);
    if (!forward) {
      w = this.restore(index);
      this.world = w;
    }
    if (w.active !== null && w.active !== index) this.finishStep(w);
    while (w.done < index) {
      this.keepSnapshot(w);
      this.beginStep(w, w.done);
      this.finishStep(w);
    }
    if (index >= this.steps.length) return;
    if (w.active === null) {
      this.keepSnapshot(w);
      this.beginStep(w, index);
    }
    const { scene } = w;
    // plays of the step that end before `local`
    while (w.script && scene.playing && !scene.playing.failed && local >= w.subStart + scene.duration) this.nextPlay(w);
    const sub = local - w.subStart;
    if (w.frameByFrame && scene.playing && !scene.playing.frozen) {
      const dt = 1 / config.frame_rate;
      for (let i = Math.floor(w.subLocal / dt) + 1; i * dt < sub; i += 1) if (i * dt > w.subLocal) scene.update_to_time(i * dt);
    }
    w.local = local;
    w.subLocal = sub;
    scene.update_to_time(sub);
  }

  /** A copy of the latest snapshot at or before step `index` (or the start). */
  restore(index) {
    let best = -1;
    for (const k of this.snapshots.keys()) if (k <= index && k > best) best = k;
    if (best >= 0) {
      const snap = this.snapshots.get(best);
      this.snapshots.delete(best); // most recently used last
      this.snapshots.set(best, snap);
      return deepCopy(snap);
    }
    return this.startWorld();
  }

  keepSnapshot(world) {
    if (this.snapshots.has(world.done)) return;
    this.snapshots.set(world.done, deepCopy(world));
    if (this.snapshots.size > SNAPSHOTS) {
      // keep the start, drop the least recently used other
      const victim = [...this.snapshots.keys()].find((k) => k !== 0);
      this.snapshots.delete(victim);
    }
  }

  // ------------------------------------------------------------------------------------------ frames and drawing

  /** Every frame Manim writes, in order, from the start: after each yield, `this.world` is that frame's scene.
   *  Yields { step, play (Manim's play count), frame (in the play), count (times the picture is written) }: a play
   *  makes len(np.arange(0, duration, 1 / fps)) frames, a still Wait one picture int(duration * fps) times, and a
   *  scene with no steps is a one-second still (the generated Python's self.wait(1)). */
  *frames(fps = config.frame_rate) {
    const dt = 1 / fps;
    const w = this.startWorld();
    this.world = w;
    if (!this.steps.length) { // the generated Python's self.wait(1)
      w.scene.wait(1);
      const { scene } = w;
      yield { step: -1, play: scene.num_plays, frame: 0, count: scene.playing.frozen ? Math.trunc(scene.duration / dt) : 1 };
      scene.finish_play();
      return;
    }
    for (const step of this.steps) {
      this.beginStep(w, step.index);
      for (;;) {
        const { scene } = w;
        const p = scene.playing;
        const play = scene.num_plays;
        if (p?.failed) {
          yield { step: step.index, play, frame: 0, count: Math.trunc(step.run_time / dt) };
        } else if (p?.frozen) {
          yield { step: step.index, play, frame: 0, count: Math.trunc(scene.duration / dt) };
        } else if (p) {
          const n = Math.ceil(scene.duration / dt);
          for (let i = 0; i < n; i += 1) {
            scene.update_to_time(i * dt);
            w.subLocal = i * dt;
            w.local = w.subStart + i * dt;
            yield { step: step.index, play, frame: i, count: 1 };
          }
        }
        if (!w.script || !this.nextPlay(w)) break;
      }
      this.finishStep(w);
    }
  }

  /** Draws the world as it is now. */
  render(ctx, width, height) {
    const { scene } = this.world;
    scene.camera.pixel_width = width;
    scene.camera.pixel_height = height;
    scene.render(ctx);
  }

  /** The editor's picture of the scene's start: every object (those that appear later faded), in the order
   *  `layout.order`, between the scene's own objects and its foreground ones. The world is a copy: the editor may
   *  move objects in it while one is dragged. */
  layoutWorld() {
    const world = this.freshWorld();
    const { scene } = world;
    const hidden = new Set(this.plan.layout?.hidden ?? []);
    const drawn = [];
    for (const id of this.plan.layout?.order ?? []) {
      const mob = world.objects.get(id);
      if (!mob) continue;
      if (hidden.has(id)) mob.fade(GHOST_FADE);
      drawn.push(mob);
    }
    // in a 3D scene, objects fixed to the frame or facing the camera are drawn that way from the start
    const fixed = Object.entries(this.plan.layout?.fixed ?? {});
    if (fixed.length && typeof scene.camera.add_fixed_in_frame_mobjects === "function") {
      const of = (how) => fixed.filter(([, h]) => h === how).map(([id]) => world.objects.get(id)).filter(Boolean);
      scene.camera.add_fixed_in_frame_mobjects(...of("in_frame"));
      scene.camera.add_fixed_orientation_mobjects(...of("orientation"));
    }
    const front = [...new Set(scene.foreground_mobjects)];
    const back = [...new Set(scene.mobjects)].filter((m) => !front.includes(m));
    world.layout = [...back, ...drawn, ...front];
    return world;
  }

  /** Draws a layoutWorld(). */
  static renderLayout(world, ctx, width, height) {
    const { camera } = world.scene;
    camera.pixel_width = width;
    camera.pixel_height = height;
    camera.reset(ctx);
    camera.capture_mobjects(ctx, world.layout);
  }
}
