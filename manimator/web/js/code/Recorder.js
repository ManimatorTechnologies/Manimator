// A stand-in for a canvas 2D context that keeps what the camera draws, so a frame made while Python code runs can be
// drawn again later, at any size, without running the code again.
//
// The camera (render/canvas.js) uses only these calls and properties. A recording is one flat array: an op code
// followed by its arguments.

const OPS = {
  setTransform: 0, beginPath: 1, moveTo: 2, bezierCurveTo: 3, closePath: 4, fill: 5, stroke: 6, fillRect: 7,
  clearRect: 8, rect: 9, clip: 10, save: 11, restore: 12, drawImage: 13, set: 14,
};

/** A linear gradient as the camera makes it: replayed with the real context's createLinearGradient. */
class Gradient {
  constructor(x0, y0, x1, y1) {
    this.line = [x0, y0, x1, y1];
    this.stops = [];
  }

  addColorStop(offset, color) {
    this.stops.push(offset, color);
  }
}

export class Recorder {
  constructor() {
    this.ops = [];
  }

  setTransform(a, b, c, d, e, f) { this.ops.push(OPS.setTransform, a, b, c, d, e, f); }
  beginPath() { this.ops.push(OPS.beginPath); }
  moveTo(x, y) { this.ops.push(OPS.moveTo, x, y); }
  bezierCurveTo(a, b, c, d, e, f) { this.ops.push(OPS.bezierCurveTo, a, b, c, d, e, f); }
  closePath() { this.ops.push(OPS.closePath); }
  fill(rule = "nonzero") { this.ops.push(OPS.fill, rule); }
  stroke() { this.ops.push(OPS.stroke); }
  fillRect(x, y, w, h) { this.ops.push(OPS.fillRect, x, y, w, h); }
  clearRect(x, y, w, h) { this.ops.push(OPS.clearRect, x, y, w, h); }
  rect(x, y, w, h) { this.ops.push(OPS.rect, x, y, w, h); }
  clip(rule = "nonzero") { this.ops.push(OPS.clip, rule); }
  save() { this.ops.push(OPS.save); }
  restore() { this.ops.push(OPS.restore); }
  drawImage(...args) { this.ops.push(OPS.drawImage, args); }
  createLinearGradient(x0, y0, x1, y1) { return new Gradient(x0, y0, x1, y1); }
}

for (const name of ["fillStyle", "strokeStyle", "globalAlpha", "globalCompositeOperation", "lineWidth", "lineJoin",
  "lineCap", "miterLimit", "imageSmoothingEnabled", "imageSmoothingQuality"]) {
  Object.defineProperty(Recorder.prototype, name, {
    set(value) { this.ops.push(OPS.set, name, value); },
    get() { throw new Error(`Recorder doesn't keep ${name}`); },
  });
}

const paint = (ctx, value) => {
  if (!(value instanceof Gradient)) return value;
  const g = ctx.createLinearGradient(...value.line);
  for (let i = 0; i < value.stops.length; i += 2) g.addColorStop(value.stops[i], value.stops[i + 1]);
  return g;
};

/** Draws a recording on a real context, `scale` times the size it was recorded at. */
export function replay(ops, ctx, scale = 1) {
  const s = scale;
  let i = 0;
  while (i < ops.length) {
    switch (ops[i++]) {
      case OPS.setTransform:
        ctx.setTransform(ops[i] * s, ops[i + 1] * s, ops[i + 2] * s, ops[i + 3] * s, ops[i + 4] * s, ops[i + 5] * s);
        i += 6;
        break;
      case OPS.beginPath: ctx.beginPath(); break;
      case OPS.moveTo: ctx.moveTo(ops[i], ops[i + 1]); i += 2; break;
      case OPS.bezierCurveTo:
        ctx.bezierCurveTo(ops[i], ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 4], ops[i + 5]);
        i += 6;
        break;
      case OPS.closePath: ctx.closePath(); break;
      case OPS.fill: ctx.fill(ops[i++]); break;
      case OPS.stroke: ctx.stroke(); break;
      case OPS.fillRect: ctx.fillRect(ops[i], ops[i + 1], ops[i + 2], ops[i + 3]); i += 4; break;
      case OPS.clearRect: ctx.clearRect(ops[i], ops[i + 1], ops[i + 2], ops[i + 3]); i += 4; break;
      case OPS.rect: ctx.rect(ops[i], ops[i + 1], ops[i + 2], ops[i + 3]); i += 4; break;
      case OPS.clip: ctx.clip(ops[i++]); break;
      case OPS.save: ctx.save(); break;
      case OPS.restore: ctx.restore(); break;
      case OPS.drawImage: ctx.drawImage(...ops[i++]); break;
      case OPS.set: ctx[ops[i]] = paint(ctx, ops[i + 1]); i += 2; break;
      default: throw new Error("bad recording");
    }
  }
}
