// A project's card picture for the Projects page: its first scene as the editor shows it, at 640x360 (the most
// POST /api/thumb takes), drawn by the browser engine.

import { BuildCache, buildObjects, loadPlanAssets } from "./plan/build.js";
import { Timeline } from "./scene/timeline.js";

const cache = new BuildCache(60);

/** The first scene's plan drawn as a PNG blob. */
export async function thumbnailPNG(plan, { width = 640, height = 360,
  fetchAsset = (name) => fetch(`/api/assets/${encodeURIComponent(name)}`, { credentials: "same-origin" }) } = {}) {
  try {
    await loadPlanAssets(plan, fetchAsset);
  } catch {
    // a missing upload: drawn without it
  }
  const built = await buildObjects(plan, { cache });
  const timeline = new Timeline(plan, built);
  await timeline.prepare({ all: false });
  const world = timeline.layoutWorld();
  const canvas = new OffscreenCanvas(width, height);
  Timeline.renderLayout(world, canvas.getContext("2d"), width, height);
  return canvas.convertToBlob({ type: "image/png" });
}
