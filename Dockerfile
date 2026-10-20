# Manimator as a website. Build:   docker build -t manimator .
# Run (try it on your own computer):
#   docker run --rm -p 8000:8000 -v manimator-data:/data --memory 1g --cpus 1 manimator
# then open http://localhost:8000/. For a real site read docs/SelfHosting.md (domain, HTTPS, limits).
#
# The server keeps projects, uploads and accounts; pictures and videos are made in the visitor's browser
# (manimator/web/js/engine/), so the image needs no Manim, LaTeX, Cairo or ffmpeg. The one exception: AI chats
# can't see the player, so a headless Chromium (Playwright's small "headless shell") runs the same engine here to
# show them frames (manimator/server/renderer.py).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY RequirementsWeb.txt .
RUN pip install -r RequirementsWeb.txt \
    && python -m playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY manimator ./manimator
COPY run.py .

# Never run as root: this program stores files that strangers upload.
RUN useradd --create-home --uid 10001 manimator && mkdir -p /data && chown manimator /data
USER manimator

ENV MANIMATOR_DATA_DIR=/data PORT=8000
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8000'))"

CMD ["python", "run.py", "--host", "0.0.0.0", "--no-open"]
