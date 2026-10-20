"""Names of Manim's colours the colour picker shows and the code generator prefers (their hex values are frozen
in color_table.py by tools/freeze_manim.py)."""

# Rows shown in the color picker.
PALETTE_ROWS: list[list[str]] = [
    ["WHITE", "GRAY_A", "GRAY_B", "GRAY_C", "GRAY_D", "GRAY_E", "BLACK"],
    ["BLUE_A", "BLUE_B", "BLUE_C", "BLUE_D", "BLUE_E", "PURE_BLUE", "PURE_CYAN"],
    ["TEAL_A", "TEAL_B", "TEAL_C", "TEAL_D", "TEAL_E", "PURE_GREEN", "PURE_YELLOW"],
    ["GREEN_A", "GREEN_B", "GREEN_C", "GREEN_D", "GREEN_E", "PURE_RED", "PURE_MAGENTA"],
    ["YELLOW_A", "YELLOW_B", "YELLOW_C", "YELLOW_D", "YELLOW_E", "ORANGE", "LIGHT_BROWN"],
    ["GOLD_A", "GOLD_B", "GOLD_C", "GOLD_D", "GOLD_E", "DARK_BROWN", "GRAY_BROWN"],
    ["RED_A", "RED_B", "RED_C", "RED_D", "RED_E", "PINK", "LIGHT_PINK"],
    ["MAROON_A", "MAROON_B", "MAROON_C", "MAROON_D", "MAROON_E", "LOGO_BLUE", "LOGO_GREEN"],
    ["PURPLE_A", "PURPLE_B", "PURPLE_C", "PURPLE_D", "PURPLE_E", "LOGO_RED", "LOGO_WHITE"],
]

# Names preferred when turning a hex value back into code (BLUE rather than BLUE_C).
PREFERRED = [
    "WHITE", "BLACK", "GRAY", "BLUE", "TEAL", "GREEN", "YELLOW", "GOLD", "RED",
    "MAROON", "PURPLE", "PINK", "LIGHT_PINK", "ORANGE", "LIGHT_BROWN", "DARK_BROWN",
    "GRAY_BROWN", "LIGHT_GRAY", "DARK_GRAY", "DARK_BLUE", "PURE_RED", "PURE_GREEN",
    "PURE_BLUE", "PURE_YELLOW", "PURE_CYAN", "PURE_MAGENTA",
]
