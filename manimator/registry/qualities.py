"""The video qualities, as Manim's -q flags. The browser engine makes the videos (web/js/engine/manim/config.js
holds the same sizes); the server only checks a project's setting against this list."""

from __future__ import annotations

# (key, label, width, height, frames per second)
QUALITIES = [
    ("l", "Low · 480p 15fps", 854, 480, 15),
    ("m", "Medium · 720p 30fps", 1280, 720, 30),
    ("h", "High · 1080p 60fps", 1920, 1080, 60),
    ("p", "2K · 1440p 60fps", 2560, 1440, 60),
    ("k", "4K · 2160p 60fps", 3840, 2160, 60),
]
QUALITY_ORDER = "".join(q for q, *_ in QUALITIES)
