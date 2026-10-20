// Talking to the local Manimator server.

const HEADERS = { "Content-Type": "application/json", "X-Manimator": "1" };

async function parse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}

export async function get(path) {
  return parse(await fetch(path, { cache: "no-store" }));
}

export async function post(path, body = {}) {
  return parse(await fetch(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) }));
}

export async function getText(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  return res.text();
}

// Edits are sent one at a time, in order. While a request is in flight, newer
// edits with the same merge key replace older queued ones, so dragging a slider
// or an object never builds up a backlog.
const queue = [];
let pumping = false;

export function enqueue(path, body, mergeKey = null) {
  return new Promise((resolve, reject) => {
    if (mergeKey) {
      const queued = queue.find((q) => q.mergeKey === mergeKey);
      if (queued) {
        queued.body = body;
        queued.waiters.push([resolve, reject]);
        return;
      }
    }
    queue.push({ path, body, mergeKey, waiters: [[resolve, reject]] });
    pump();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const item = queue.shift();
    try {
      const data = await post(item.path, item.body);
      item.waiters.forEach(([resolve]) => resolve(data));
    } catch (err) {
      item.waiters.forEach(([, reject]) => reject(err));
    }
  }
  pumping = false;
}

// ---------------------------------------------------------------- files
/** Open the browser's file chooser. Resolves with the chosen File, or null if cancelled. */
export function chooseLocalFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    const done = (file) => { input.remove(); resolve(file); };
    input.addEventListener("change", () => done(input.files[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** Send a picture or SVG to the server. Resolves with { name, files }; the name is what objects refer to. */
export async function uploadAsset(file) {
  return parse(await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "X-Manimator": "1", "Content-Type": "application/octet-stream" },
    body: file,
  }));
}

/** Send a big file (a video for a presentation, a rendered scene) with progress: onProgress(0..1) as it goes.
 *  Resolves with the server's answer. */
export function sendWithProgress(url, body, onProgress = () => {}, signal = null) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("X-Manimator", "1");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || (xhr.status === 413 ? "That file is too large." : `Server error (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error("The upload broke off. Check your connection and try again."));
    xhr.onabort = () => reject(new DOMException("The upload was cancelled.", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** Save a file the server generates (project, Python script, video) through the browser's download. */
export function downloadFromServer(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
