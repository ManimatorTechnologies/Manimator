"""The kinds of scene a project scene can be: Manim's Scene class and its specialised subclasses.

Each kind lists its settings as Params (stored in Scene.options). The code generator turns them into
constructor arguments and setup lines, and the scene actions in animations.py say which kinds they work in.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .params import BOOL, COLOR, CORNERS, DIRECTION, ENUM, FLOAT, POINT, Param

SCENE = "Scene"
MOVING_CAMERA = "MovingCameraScene"
ZOOMED = "ZoomedScene"
VECTOR_SCENE = "VectorScene"
LINEAR = "LinearTransformationScene"
THREE_D = "ThreeDScene"
SPECIAL_THREE_D = "SpecialThreeDScene"


@dataclass(frozen=True)
class SceneKind:
    key: str  # the Manim class the generated scene inherits from
    description: str
    options: tuple[Param, ...] = ()
    # option -> the BOOL option it depends on; it is hidden and ignored while that one is off
    requires: dict = field(default_factory=dict)
    three_d: bool = False  # a ThreeDCamera: objects have a height, fixed-in-frame objects
    moving_camera: bool = False  # self.camera.frame can be moved and zoomed

    def option(self, name: str) -> Param | None:
        return next((p for p in self.options if p.name == name), None)

    def active(self, name: str, values: dict) -> bool:
        """Whether an option is in effect, given the scene's option values."""
        need = self.requires.get(name)
        if need is None:
            return True
        return bool(values.get(need, self.option(need).default)) and self.active(need, values)


_CAMERA = (
    Param("camera_center", POINT, [0.0, 0.0], label="Camera center",
          tooltip="The point in the middle of the picture when the scene starts"),
    Param("camera_zoom", FLOAT, 1.0, label="Camera zoom", min=0.1, max=20, step=0.1,
          tooltip="1 shows the whole frame; 2 shows half as much, twice as large"),
)

_ZOOM = (
    Param("zoom_at_start", BOOL, False, label="Zoom on at start",
          tooltip="Show the lens and its display from the first frame. Otherwise add a 'Turn on zoom' step."),
    Param("zoomed_camera_frame_starting_position", POINT, [0.0, 0.0], label="Lens position",
          tooltip="Where the lens (the small frame that gets magnified) starts"),
    Param("zoom_factor", FLOAT, 0.15, label="Lens size", min=0.01, max=1, step=0.01,
          tooltip="The lens is this fraction of the display's size: 0.15 magnifies about 6.7 times"),
    Param("zoomed_display_width", FLOAT, 3.0, label="Display width", min=0.2, max=14, step=0.25),
    Param("zoomed_display_height", FLOAT, 3.0, label="Display height", min=0.2, max=8, step=0.25),
    Param("zoomed_display_corner", DIRECTION, "UR", label="Display corner", choices=CORNERS,
          tooltip="The corner of the frame the magnified picture sits in"),
    Param("lens_color", COLOR, "#FFFFFF", label="Lens color"),
    Param("display_color", COLOR, "#FFFFFF", label="Display border"),
)

_BASIS_WIDTH = Param("basis_vector_stroke_width", FLOAT, 6.0, label="Basis width", min=0.5, max=20, step=0.5)

_VECTOR = (
    Param("background", ENUM, "plane", label="Background",
          choices=(("plane", "Number plane"), ("axes", "Axes"), ("none", "Nothing"))),
    Param("basis_vectors", BOOL, False, label="Basis vectors", tooltip="The unit vectors î and ĵ along x and y"),
    Param("basis_vector_labels", BOOL, False, label="Basis labels", tooltip="The names î and ĵ next to them"),
    _BASIS_WIDTH,
)

_LINEAR = (
    Param("include_background_plane", BOOL, True, label="Background grid", tooltip="A faint grid that stays put"),
    Param("show_coordinates", BOOL, False, label="Numbers", tooltip="Number the background grid's axes"),
    Param("include_foreground_plane", BOOL, True, label="Moving grid", tooltip="The grid the transformations move"),
    Param("unit_square", BOOL, False, label="Unit square", tooltip="A square on î and ĵ that transforms with the grid"),
    Param("unit_square_color", COLOR, "#FFFF00", label="Square color"),
    Param("show_basis_vectors", BOOL, True, label="Basis vectors", tooltip="The unit vectors î and ĵ along x and y"),
    Param("i_hat_color", COLOR, "#83C167", label="î color"),
    Param("j_hat_color", COLOR, "#FC6255", label="ĵ color"),
    _BASIS_WIDTH,
    Param("leave_ghost_vectors", BOOL, False, label="Ghost vectors",
          tooltip="Leave a faded copy of every vector where it was before each transformation"),
)


def _orientation(theta: float) -> tuple[Param, ...]:
    return (
        Param("phi", FLOAT, 70.0, label="Tilt", min=0, max=180, step=5, decimals=1, slider=True,
              tooltip="0 looks straight down; 90 looks from the side"),
        Param("theta", FLOAT, theta, label="Rotation", min=-360, max=360, step=5, decimals=1,
              tooltip="Turns the camera around the vertical axis"),
        Param("gamma", FLOAT, 0.0, label="Roll", min=-360, max=360, step=5, decimals=1,
              tooltip="Turns the picture around the line of sight"),
        Param("zoom", FLOAT, 1.0, label="Zoom", min=0.1, max=20, step=0.1),
    )


_SPECS = [
    SceneKind(SCENE, "A fixed camera looking at the flat scene"),
    SceneKind(MOVING_CAMERA, "A camera that can pan and zoom during the video", _CAMERA, moving_camera=True),
    SceneKind(ZOOMED, "A moving camera plus a magnifying lens shown in a picture-in-picture display",
              _CAMERA + _ZOOM, moving_camera=True),
    SceneKind(VECTOR_SCENE, "A grid for drawing vectors, with î and ĵ and a coordinates demo", _VECTOR,
              requires={"basis_vector_stroke_width": "basis_vectors"}),
    SceneKind(LINEAR, "A grid that matrices and functions transform, carrying vectors and shapes along",
              _LINEAR, requires={"show_coordinates": "include_background_plane",
                                 "unit_square": "include_foreground_plane", "unit_square_color": "unit_square",
                                 "i_hat_color": "show_basis_vectors", "j_hat_color": "show_basis_vectors",
                                 "basis_vector_stroke_width": "show_basis_vectors"}),
    SceneKind(THREE_D, "A 3D camera that can tilt, turn, spin and fly around", _orientation(-50.0), three_d=True),
    SceneKind(SPECIAL_THREE_D, "ThreeDScene with Manim's preset camera angle (tilt 70°, rotation -110°)",
              _orientation(-110.0), three_d=True),
]

SCENE_KINDS: dict[str, SceneKind] = {s.key: s for s in _SPECS}

# How an object takes part in a LinearTransformationScene (MobjectItem.transform_role).
AUTO = ""
TRANSFORMABLE = "transformable"
MOVING_VECTOR = "vector"
FOREGROUND = "foreground"
STATIC = "static"
TRANSFORM_ROLES = (
    (TRANSFORMABLE, "Transforms with the grid"),
    (MOVING_VECTOR, "A vector that moves with the grid"),
    (FOREGROUND, "Stays put, in front"),
    (STATIC, "Stays put"),
)
VECTOR_TYPES = ("Vector", "Arrow")  # what LinearTransformationScene.add_vector can carry along

# How an object faces a 3D camera (MobjectItem.fixed).
FIXED_IN_FRAME = "in_frame"
FIXED_ORIENTATION = "orientation"
FIXED_CHOICES = (
    ("", "Part of the 3D world"),
    (FIXED_IN_FRAME, "Fixed in frame (stays put on screen)"),
    (FIXED_ORIENTATION, "Always faces the camera"),
)
