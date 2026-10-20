"""Math expressions typed by the user (function graphs, surfaces, vector fields).

The text is parsed and rebuilt from an allow-list, so only numbers, the declared
variables, a few operators and numpy math functions can ever reach the generated
code. Anything else is rejected with a message the user can act on.
"""

from __future__ import annotations

import ast
import math

MAX_LENGTH = 200
MAX_NODES = 120
MAX_CONSTANT = 1e9
MAX_EXPONENT = 64

# user-facing name -> numpy name
FUNCTIONS = {
    "sin": "sin", "cos": "cos", "tan": "tan",
    "asin": "arcsin", "acos": "arccos", "atan": "arctan", "atan2": "arctan2",
    "sinh": "sinh", "cosh": "cosh", "tanh": "tanh",
    "exp": "exp", "log": "log", "ln": "log", "log10": "log10", "log2": "log2",
    "sqrt": "sqrt", "cbrt": "cbrt", "abs": "abs", "sign": "sign",
    "floor": "floor", "ceil": "ceil", "min": "minimum", "max": "maximum",
}
ARITY = {"atan2": 2, "min": 2, "max": 2}
CONSTANTS = {"pi": "np.pi", "e": "np.e", "tau": "(2 * np.pi)"}
HELP = "Use numbers, the variables, + - * / ** %, pi, e, and functions such as sin, cos, exp, sqrt, abs."

_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod, ast.FloorDiv)


class ExprError(ValueError):
    pass


class _Rewriter(ast.NodeTransformer):
    def __init__(self, variables: tuple[str, ...], subst: dict[str, str]):
        self.variables = set(variables)
        self.subst = {name: ast.parse(code, mode="eval").body for name, code in subst.items()}
        self.nodes = 0

    def _uses_variable(self, node) -> bool:
        return any(isinstance(n, ast.Name) and n.id in self.variables for n in ast.walk(node))

    def _count(self) -> None:
        self.nodes += 1
        if self.nodes > MAX_NODES:
            raise ExprError("That expression is too long.")

    def visit_Expression(self, node):
        node.body = self.visit(node.body)
        return node

    def visit_Constant(self, node):
        self._count()
        v = node.value
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ExprError(f"Only numbers are allowed, not {v!r}.")
        if abs(v) > MAX_CONSTANT:
            raise ExprError("That number is too large.")
        return node

    def visit_Name(self, node):
        self._count()
        name = node.id
        if name in self.variables:
            return self.subst[name] if name in self.subst else ast.Name(name, ast.Load())
        if name in CONSTANTS:
            return ast.parse(CONSTANTS[name], mode="eval").body
        if name in FUNCTIONS:
            raise ExprError(f"'{name}' is a function; write {name}(...).")
        known = ", ".join(sorted(self.variables))
        raise ExprError(f"Unknown name '{name}'. Use {known}, pi, e or a function like sin(...).")

    def visit_Call(self, node):
        self._count()
        if not isinstance(node.func, ast.Name) or node.keywords:
            raise ExprError(f"Only simple functions are allowed. {HELP}")
        name = node.func.id
        if name not in FUNCTIONS:
            raise ExprError(f"Unknown function '{name}'. Try {', '.join(sorted(FUNCTIONS)[:8])}, ...")
        if len(node.args) != ARITY.get(name, 1):
            raise ExprError(f"{name}() takes {ARITY.get(name, 1)} value(s).")
        func = ast.Attribute(ast.Name("np", ast.Load()), FUNCTIONS[name], ast.Load())
        return ast.Call(func, [self.visit(a) for a in node.args], [])

    def visit_UnaryOp(self, node):
        self._count()
        if not isinstance(node.op, (ast.UAdd, ast.USub)):
            raise ExprError(f"That operator isn't allowed. {HELP}")
        node.operand = self.visit(node.operand)
        return node

    def visit_BinOp(self, node):
        self._count()
        if not isinstance(node.op, _BINOPS):
            raise ExprError(f"That operator isn't allowed. {HELP}")
        if isinstance(node.op, ast.Pow):
            exp = node.right
            uses_variable = self._uses_variable(exp)
            if isinstance(exp, ast.UnaryOp) and isinstance(exp.operand, ast.Constant):
                exp = exp.operand
            constant = isinstance(exp, ast.Constant) and isinstance(exp.value, (int, float))
            if constant and abs(exp.value) > MAX_EXPONENT:
                raise ExprError("That exponent is too large.")
            if not constant and not uses_variable:
                raise ExprError("An exponent must be a plain number or use a variable.")
            # Python works with whole numbers of any size, so powers of powers of plain numbers multiply their
            # exponents into numbers far too big to compute (the exponent limit only sees one level).
            if constant and not self._uses_variable(node.left) and any(
                    isinstance(n, ast.BinOp) and isinstance(n.op, ast.Pow) for n in ast.walk(node.left)):
                raise ExprError("A power of a power of plain numbers isn't allowed. Work that number out first.")
        node.left = self.visit(node.left)
        node.right = self.visit(node.right)
        return node

    def generic_visit(self, node):
        raise ExprError(f"That isn't allowed in an expression. {HELP}")


def _checked(text: str, variables: tuple[str, ...], subst: dict[str, str] | None = None) -> ast.Expression:
    """Parse and validate `text`; the result uses only numpy functions (np.<name>) and the variables."""
    if not isinstance(text, str):
        raise ExprError("Expected an expression.")
    text = text.strip().replace("^", "**")
    if not text:
        raise ExprError("The expression is empty.")
    if len(text) > MAX_LENGTH:
        raise ExprError("That expression is too long.")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError:
        raise ExprError(f"That isn't a valid expression. Use * for multiplication, e.g. 2*x. {HELP}") from None
    tree = _Rewriter(variables, subst or {}).visit(tree)
    ast.fix_missing_locations(tree)
    return tree


def compile_expr(text: str, variables: tuple[str, ...], subst: dict[str, str] | None = None) -> str:
    """Validate `text` and return Python source for it (numpy functions, no other names).

    `subst` replaces a variable with a source snippet, e.g. {"x": "p[0]"}.
    """
    return ast.unparse(_checked(text, variables, subst))


# ---------------------------------------------------------------------- syntax trees for the browser

# numpy name -> the same function in Python's math module, for folding the parts without variables
_MATH = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan, "arcsin": math.asin, "arccos": math.acos,
    "arctan": math.atan, "arctan2": math.atan2, "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh,
    "exp": math.exp, "log": math.log, "log10": math.log10, "log2": math.log2, "sqrt": math.sqrt,
    "cbrt": lambda v: math.copysign(abs(v) ** (1 / 3), v), "abs": abs,
    "sign": lambda v: float((v > 0) - (v < 0)), "floor": lambda v: float(math.floor(v)),
    "ceil": lambda v: float(math.ceil(v)), "minimum": min, "maximum": max,
}
_OPS = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.Pow: "**", ast.Mod: "%", ast.FloorDiv: "//"}
_APPLY = {"+": lambda a, b: a + b, "-": lambda a, b: a - b, "*": lambda a, b: a * b, "/": lambda a, b: a / b,
          "**": lambda a, b: a ** b, "%": lambda a, b: a % b, "//": lambda a, b: a // b}


def _fold(value):
    """A folded constant, or None when it can't stand for what numpy would compute (complex, nan, too big)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _tree(node):
    """JSON for a checked expression: numbers, {"v": name}, {"op", "a", "b"}, {"op": "neg", "a"}, {"f", "args"}.
    Parts without variables are worked out here."""
    if isinstance(node, ast.Expression):
        return _tree(node.body)
    if isinstance(node, ast.Constant):
        return float(node.value)
    if isinstance(node, ast.Name):
        return {"v": node.id}
    if isinstance(node, ast.Attribute):  # np.pi, np.e
        return {"pi": math.pi, "e": math.e}[node.attr]
    if isinstance(node, ast.UnaryOp):
        a = _tree(node.operand)
        if isinstance(node.op, ast.UAdd):
            return a
        return -a if isinstance(a, float) else {"op": "neg", "a": a}
    if isinstance(node, ast.BinOp):
        op, a, b = _OPS[type(node.op)], _tree(node.left), _tree(node.right)
        if isinstance(a, float) and isinstance(b, float):
            try:
                folded = _fold(_APPLY[op](a, b))
            except (ArithmeticError, ValueError):
                folded = None
            if folded is not None:
                return folded
        return {"op": op, "a": a, "b": b}
    if isinstance(node, ast.Call):  # np.<name>(...)
        name = node.func.attr
        args = [_tree(a) for a in node.args]
        if all(isinstance(a, float) for a in args):
            try:
                folded = _fold(_MATH[name](*args))
            except (ArithmeticError, ValueError):
                folded = None
            if folded is not None:
                return folded
        return {"f": name, "args": args}
    raise ExprError(f"That isn't allowed in an expression. {HELP}")


def expr_tree(text: str, variables: tuple[str, ...]):
    """The checked expression as a syntax tree for the browser, which evaluates it without parsing (the page's
    Content-Security-Policy allows no eval). Same allow-list and limits as compile_expr."""
    return _tree(_checked(text, variables))
