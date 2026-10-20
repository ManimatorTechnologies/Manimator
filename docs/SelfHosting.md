# Running Manimator as a website

Manimator is always a web server; `Manimator.bat` (or `python run.py`) just runs it for you on your own computer.
Opened up to others, it gives:

- **Many visitors at once**, each with a private workspace and their own list of projects, kept on the server as they
  edit. **Download** gives people their own copy.
- **Pictures and SVGs** uploaded through the page, checked, and kept in the visitor's own folder.
- **Pictures and videos made in each visitor's browser** (`manimator/web/js/engine/`). The server sends a scene plan
  (JSON) and never runs Manim, so it needs little CPU or memory, and videos never pass through it.

There are no accounts: a visitor's projects belong to their browser through a cookie.

## Try it on your own computer

```bash
python run.py --port 8000
```

Open <http://localhost:8000/>. Open it in a second browser (or a private window) to see a second, separate visitor.

## Run it with Docker

```bash
docker build -t manimator .
docker run --rm -p 8000:8000 -v manimator-data:/data --memory 1g --cpus 1 manimator
```

The image holds Python and a few small packages (FastAPI, Uvicorn, httpx, Pillow, Pygments, and Playwright's headless
Chromium for AI chat previews): no Manim, LaTeX, Cairo or ffmpeg.

## Settings

Everything is an environment variable (set with `-e NAME=value` in Docker). `run.py` also reads a `.env` file
(`NAME=value` lines) from the folder it is started in, or from `MANIMATOR_ENV_FILE`; real environment variables win.

| Variable | Default | What it does |
|---|---|---|
| `MANIMATOR_ALLOWED_HOSTS` | `localhost` only | Your site's domain(s), comma separated, for example `studio.example.com`. Requests for any other name are refused. `*` allows any name (not for production). |
| `MANIMATOR_HTTPS` | off | Set to `1` once the site is behind HTTPS. Marks the session cookie *Secure* and sends HSTS. |
| `MANIMATOR_SITE_URL` | from the request | The site's address, e.g. `https://studio.example.com`. |
| `MANIMATOR_DATA_DIR` | per-user app folder | Where visitors' projects and uploads live. Use a persistent disk. |
| `MANIMATOR_SESSION_DAYS` | 90 | A visitor who doesn't come back has their projects and files deleted after this many days. |
| `MANIMATOR_MAX_PROJECTS` | 20 | Projects one visitor can keep. |
| `MANIMATOR_MAX_WORKSPACES` | 300 | Visitors held in memory at once. |
| `MANIMATOR_PREVIEWS` | 1 | `0` turns off the frames AI chats can ask to see (no headless Chromium is started). |
| `PORT` | 8000 | Port to listen on. |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Proxy addresses allowed to tell the app the visitor's real IP (needed for per-IP limits behind a proxy). |

Other limits (upload size 8 MB, 20 uploaded files and 40 MB per visitor, project size, scenes/objects/steps per project)
are in `WebConfig` in `manimator/server/web.py`.

## Putting it on the internet

1. Get a domain and a server.
2. Run the container (or `run.py`) bound to `127.0.0.1`, and put a reverse proxy in front for HTTPS. With
   [Caddy](https://caddyserver.com), this whole file is enough and gets a certificate by itself:

   ```
   studio.example.com {
       reverse_proxy 127.0.0.1:8000
   }
   ```
3. Set `MANIMATOR_ALLOWED_HOSTS=studio.example.com` and `MANIMATOR_HTTPS=1`.
4. Run **one** copy of the app. A visitor's session lives in that process and on its disk, so two copies behind a
   load balancer would give people different projects on different requests.

Sizing: the server only edits and stores JSON, so 1–2 CPU cores and 1–2 GB of memory serve many people. "Serverless"
and per-request platforms are a poor fit: sessions need a disk.

The license allows running Manimator for others only for noncommercial purposes; see [LICENSE](../LICENSE).

## What protects the server and the visitors

- **Private workspaces.** Each visitor gets a random 128-bit id in an `HttpOnly`, `SameSite=Lax` cookie. Only ids the
  server issued are ever opened, and the id is only ever used as a folder name after a strict check.
- **No paths from visitors.** Nothing in the API takes a file path. Files come in through upload, are checked (real
  picture formats, size and pixel limits; SVGs with scripts, links or entities are refused) and are referred to by a
  plain name. A project file from outside is re-checked on load, so it can't point at the server's files.
- **Formulas are maths only.** Anything typed into a formula box is parsed and rebuilt from a short list of allowed
  operations and functions. It never reaches the generated code as text.
- **Nothing a visitor makes runs on the server.** No Manim, LaTeX or ffmpeg is installed: formulas are evaluated, text
  and LaTeX drawn and videos made in the visitor's own browser, under the site's Content-Security-Policy (no `eval`).
  Customizations' code runs only in a sandboxed frame (`manimator/web/sandbox/`).
- **Limits everywhere.** Request size, upload size, files per visitor, objects and steps per project, requests per
  second, new visitors per IP.
- **Browser protections:** a Content-Security-Policy (scripts only from the site itself), no framing, no content
  sniffing, and a required custom header on every change (so another website can't make a visitor's browser act on
  this one).
- **Run as a normal user** (not root) in the container; give it a memory and CPU limit (`--memory`, `--cpus`).
