// Making the videos in the browser: each scene's frames, exactly as Manim writes them (Timeline.frames), drawn on
// an OffscreenCanvas, encoded with WebCodecs and put in an MP4 (H.264), or a WebM (VP9) where H.264 can't be made.
//
//   if (!canMakeVideos()) ...;   // "This browser can't make videos..."
//   const video = await makeVideo(plan, "h", { signal, onProgress });   // { blob, type, ext }

import { config, QUALITIES, setQuality } from "./manim/config.js";
import { loadMp4Muxer, loadWebmMuxer } from "./mw/lib.js";
import { BuildCache, buildObjects, loadPlanAssets } from "./plan/build.js";
import { Timeline } from "./scene/timeline.js";

/** Bits per second for each quality letter. */
export const BITRATES = { l: 1.5e6, m: 4e6, h: 10e6, p: 16e6, k: 35e6 };

// H.264 High profile, at a level for the size and frame rate; then Main and Baseline at that level.
const AVC_LEVELS = { l: "1e", m: "1f", h: "2a", p: "33", k: "34" };
const avcCodecs = (q) => ["6400", "4d00", "4200"].map((profile) => `avc1.${profile}${AVC_LEVELS[q]}`);
const VP9 = ["vp09.00.41.08", "vp09.00.51.08", "vp09.00.10.08"];

export const UNSUPPORTED = "This browser can't make videos. Use Chrome, Edge, Safari or desktop Firefox.";

export function canMakeVideos() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

function encoderConfig(q, codec) {
  const { pixel_width: width, pixel_height: height, frame_rate: framerate } = QUALITIES[q];
  const cfg = { codec, width, height, bitrate: BITRATES[q], framerate, latencyMode: "quality" };
  if (codec.startsWith("avc1")) cfg.avc = { format: "avc" };
  return cfg;
}

/** The codec this browser can make at quality `q`: { container: "mp4" | "webm", config } or null. */
export async function chooseCodec(q) {
  if (!canMakeVideos()) return null;
  for (const [container, codecs] of [["mp4", avcCodecs(q)], ["webm", VP9]]) {
    for (const codec of codecs) {
      try {
        const { supported } = await VideoEncoder.isConfigSupported(encoderConfig(q, codec));
        if (supported) return { container, config: encoderConfig(q, codec) };
      } catch {
        // not this one
      }
    }
  }
  return null;
}

/** The qualities this browser can make videos at. */
export async function supportedQualities() {
  const out = {};
  for (const q of Object.keys(QUALITIES)) out[q] = (await chooseCodec(q)) !== null;
  return out;
}

const abortError = () => new DOMException("The video was cancelled.", "AbortError");

// A quick yield to the page (a MessageChannel message, faster than setTimeout's clamp).
const channel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const yieldToPage = () => new Promise((resolve) => {
  if (!channel) {
    setTimeout(resolve, 0);
    return;
  }
  channel.port1.onmessage = () => resolve();
  channel.port2.postMessage(0);
});

/**
 * Makes one scene's video. `plan`: the scene plan; `q`: the quality letter. Options: signal (an AbortSignal),
 * onProgress(fraction, frame), fetchAsset(name) for uploads, cache (a BuildCache to share between scenes).
 * Resolves with { blob, type, ext, frames, seconds }.
 */
export async function makeVideo(plan, q, { signal = null, onProgress = () => {}, fetchAsset, cache = new BuildCache() } = {}) {
  const choice = await chooseCodec(q);
  if (!choice) throw new Error(UNSUPPORTED);
  setQuality(q);
  const { pixel_width: width, pixel_height: height, frame_rate: fps } = config;
  await loadPlanAssets(plan, fetchAsset);
  const built = await buildObjects(plan, { cache });
  const timeline = new Timeline(plan, built);
  await timeline.prepare();
  if (signal?.aborted) throw abortError();

  const mp4 = choice.container === "mp4";
  const lib = await (mp4 ? loadMp4Muxer() : loadWebmMuxer());
  const muxer = new lib.Muxer({
    target: new lib.ArrayBufferTarget(),
    video: mp4 ? { codec: "avc", width, height, frameRate: fps } : { codec: "V_VP9", width, height, frameRate: fps },
    ...(mp4 ? { fastStart: "in-memory", firstTimestampBehavior: "offset" } : {}),
  });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure(choice.config);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  const estimate = Math.max(1, Math.round((timeline.duration || 1) * fps));
  const frameUs = 1e6 / fps;
  const keyEvery = fps * 2;
  let index = 0;
  let lastYield = performance.now();
  try {
    for (const frame of timeline.frames(fps)) {
      timeline.render(ctx, width, height);
      const picture = new VideoFrame(canvas, { timestamp: Math.round(index * frameUs), duration: Math.round(frameUs) });
      for (let k = 0; k < frame.count; k += 1) {
        const copy = k === 0 ? picture : new VideoFrame(picture, { timestamp: Math.round(index * frameUs) });
        encoder.encode(copy, { keyFrame: index % keyEvery === 0 });
        if (copy !== picture) copy.close();
        index += 1;
        while (encoder.encodeQueueSize > 4 && !failure) await new Promise((r) => { encoder.addEventListener("dequeue", r, { once: true }); });
        if (failure) throw failure;
        if (signal?.aborted) throw abortError();
      }
      picture.close();
      if (performance.now() - lastYield > 30) { // keep the page responsive
        onProgress(Math.min(0.99, index / estimate), index);
        await yieldToPage();
        lastYield = performance.now();
        if (signal?.aborted) throw abortError();
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  onProgress(1, index);
  const type = mp4 ? "video/mp4" : "video/webm";
  return { blob: new Blob([muxer.target.buffer], { type }), type, ext: mp4 ? "mp4" : "webm", frames: index, seconds: index / fps };
}
