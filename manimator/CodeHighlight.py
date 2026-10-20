"""Syntax colours for Code objects, worked out the way Manim's Code does (for the browser's scene plan).

Manim highlights with Pygments' HtmlFormatter and reads the colour of each top-level <span> of the <pre> with
BeautifulSoup's "html.parser", which is Python's own html.parser; so does this, without BeautifulSoup.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

_COLOR = re.compile(r"color: (#[A-Fa-f0-9]{6}|#[A-Fa-f0-9]{3})")


class _PreChildren(HTMLParser):
    """The <pre>'s direct children as (style of a top-level <span>, or None for text; its text)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0  # 0: outside the <pre>; 1: directly in it; 2+: inside one of its children
        self.children: list[list] = []

    def handle_starttag(self, tag, attrs):
        if self.depth == 0:
            if tag == "pre":
                self.depth = 1
            return
        if self.depth == 1:
            style = dict(attrs).get("style") if tag == "span" else None
            self.children.append([style, ""])
        self.depth += 1

    def handle_endtag(self, tag):
        if self.depth > 1:
            self.depth -= 1
        elif self.depth == 1 and tag == "pre":
            self.depth = 0

    def handle_data(self, data):
        if self.depth == 1:
            self.children.append([None, data])
        elif self.depth > 1:
            self.children[-1][1] += data


def highlight(code: str, language: str, style: str, tab_width: int = 4) -> dict:
    """Lines of the listing, coloured ranges [line, start, end, "#rrggbb"], and the style's colours."""
    from pygments import highlight as pyg_highlight
    from pygments.formatters.html import HtmlFormatter
    from pygments.lexers import get_lexer_by_name
    from pygments.token import Text as TextToken

    lexer = get_lexer_by_name(language)
    code = code.expandtabs(tabsize=tab_width)
    formatter = HtmlFormatter(style=style, noclasses=True, cssclasses="")
    selected = formatter.style
    parser = _PreChildren()
    parser.feed(pyg_highlight(code, lexer, formatter))
    text = "".join(t for _style, t in parser.children)
    lines = text.removesuffix("\n").split("\n")
    spans = []
    i_line = i_char = 0
    for style, chunk in parser.children:
        if style:
            match = _COLOR.match(style)
            if match:
                spans.append([i_line, i_char, i_char + len(chunk), _hex6(match.group(1))])
        for ch in chunk:
            if ch == "\n":
                i_line += 1
                i_char = 0
            else:
                i_char += 1
    default = selected.style_for_token(TextToken).get("color")
    foreground = "#000000" if default is None else _hex6(f"#{default}")
    line_numbers = selected.line_number_color
    return {
        "lines": lines,
        "spans": spans,
        "foreground": foreground,
        "line_number_color": foreground if line_numbers == "inherit" else _hex6(line_numbers),
        "background": _hex6(selected.background_color),
    }


def _hex6(color: str) -> str:
    c = color.strip()
    if len(c) == 4 and c.startswith("#"):
        c = "#" + "".join(ch * 2 for ch in c[1:])
    return c.upper()
