// Manim's rate functions (manim/utils/rate_functions.py), line for line, with the same clamping:
// `unitInterval` ones give 0 before 0 and 1 after 1, `zero` ones give 0 outside [0, 1].

const unitInterval = (f) => (t, ...args) => (t >= 0 && t <= 1 ? f(t, ...args) : t < 0 ? 0 : 1);
const zero = (f) => (t, ...args) => (t >= 0 && t <= 1 ? f(t, ...args) : 0);

export const sigmoid = (x) => 1.0 / (1 + Math.exp(-x));

export const linear = unitInterval((t) => t);

export const smooth = unitInterval((t, inflection = 10.0) => {
  const error = sigmoid(-inflection / 2);
  return Math.min(Math.max((sigmoid(inflection * (t - 0.5)) - error) / (1 - 2 * error), 0), 1);
});

export const smoothstep = unitInterval((t) => 3 * t ** 2 - 2 * t ** 3);
export const smootherstep = unitInterval((t) => 6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3);
export const smoothererstep = unitInterval((t) => 35 * t ** 4 - 84 * t ** 5 + 70 * t ** 6 - 20 * t ** 7);
export const rush_into = unitInterval((t, inflection = 10.0) => 2 * smooth(t / 2.0, inflection));
export const rush_from = unitInterval((t, inflection = 10.0) => 2 * smooth(t / 2.0 + 0.5, inflection) - 1);
export const slow_into = unitInterval((t) => Math.sqrt(1 - (1 - t) * (1 - t)));
export const double_smooth = unitInterval((t) => (t < 0.5 ? 0.5 * smooth(2 * t) : 0.5 * (1 + smooth(2 * t - 1))));

export const there_and_back = zero((t, inflection = 10.0) => {
  const newT = t < 0.5 ? 2 * t : 2 * (1 - t);
  return smooth(newT, inflection);
});

export const there_and_back_with_pause = zero((t, pauseRatio = 1.0 / 3) => {
  const a = 2.0 / (1.0 - pauseRatio);
  if (t < 0.5 - pauseRatio / 2) return smooth(a * t);
  if (t < 0.5 + pauseRatio / 2) return 1;
  return smooth(a - a * t);
});

export const running_start = unitInterval((t, pullFactor = -0.5) => {
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  const t6 = t5 * t;
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const mt4 = mt3 * mt;
  return 15 * t2 * mt4 * pullFactor + 20 * t3 * mt3 * pullFactor + 15 * t4 * mt2 + 6 * t5 * mt + t6;
});

export const not_quite_there = (func = smooth, proportion = 0.7) => (t, ...args) => proportion * func(t, ...args);

export const wiggle = zero((t, wiggles = 2) => there_and_back(t) * Math.sin(wiggles * Math.PI * t));

export const squish_rate_func = (func, a = 0.4, b = 0.6) => (t, ...args) => {
  if (a === b) return a;
  const newT = t < a ? 0.0 : t > b ? 1.0 : (t - a) / (b - a);
  return func(newT, ...args);
};

export const lingering = unitInterval((t) => squish_rate_func((x) => x, 0, 0.8)(t));
export const exponential_decay = unitInterval((t, halfLife = 0.1) => 1 - Math.exp(-t / halfLife));

export const ease_in_sine = unitInterval((t) => 1 - Math.cos((t * Math.PI) / 2));
export const ease_out_sine = unitInterval((t) => Math.sin((t * Math.PI) / 2));
export const ease_in_out_sine = unitInterval((t) => -(Math.cos(Math.PI * t) - 1) / 2);
export const ease_in_quad = unitInterval((t) => t * t);
export const ease_out_quad = unitInterval((t) => 1 - (1 - t) * (1 - t));
export const ease_in_out_quad = unitInterval((t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2));
export const ease_in_cubic = unitInterval((t) => t * t * t);
export const ease_out_cubic = unitInterval((t) => 1 - (1 - t) ** 3);
export const ease_in_out_cubic = unitInterval((t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2));
export const ease_in_quart = unitInterval((t) => t * t * t * t);
export const ease_out_quart = unitInterval((t) => 1 - (1 - t) ** 4);
export const ease_in_out_quart = unitInterval((t) => (t < 0.5 ? 8 * t * t * t * t : 1 - (-2 * t + 2) ** 4 / 2));
export const ease_in_quint = unitInterval((t) => t * t * t * t * t);
export const ease_out_quint = unitInterval((t) => 1 - (1 - t) ** 5);
export const ease_in_out_quint = unitInterval((t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - (-2 * t + 2) ** 5 / 2));
export const ease_in_expo = unitInterval((t) => (t === 0 ? 0 : 2 ** (10 * t - 10)));
export const ease_out_expo = unitInterval((t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)));
export const ease_in_out_expo = unitInterval((t) => {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
});
export const ease_in_circ = unitInterval((t) => 1 - Math.sqrt(1 - t ** 2));
export const ease_out_circ = unitInterval((t) => Math.sqrt(1 - (t - 1) ** 2));
export const ease_in_out_circ = unitInterval((t) => (t < 0.5
  ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
  : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2));

const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;
const C4 = (2 * Math.PI) / 3;
const C5 = (2 * Math.PI) / 4.5;

export const ease_in_back = unitInterval((t) => C3 * t * t * t - C1 * t * t);
export const ease_out_back = unitInterval((t) => 1 + C3 * (t - 1) ** 3 + C1 * (t - 1) ** 2);
export const ease_in_out_back = unitInterval((t) => (t < 0.5
  ? ((2 * t) ** 2 * ((C2 + 1) * 2 * t - C2)) / 2
  : ((2 * t - 2) ** 2 * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2));
export const ease_in_elastic = unitInterval((t) => {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * C4);
});
export const ease_out_elastic = unitInterval((t) => {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1;
});
export const ease_in_out_elastic = unitInterval((t) => {
  if (t === 0) return 0;
  if (t === 1) return 1;
  if (t < 0.5) return -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * C5)) / 2;
  return (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * C5)) / 2 + 1;
});

const N1 = 7.5625;
const D1 = 2.75;
export const ease_out_bounce = unitInterval((t) => {
  if (t < 1 / D1) return N1 * t * t;
  if (t < 2 / D1) return N1 * (t - 1.5 / D1) * (t - 1.5 / D1) + 0.75;
  if (t < 2.5 / D1) return N1 * (t - 2.25 / D1) * (t - 2.25 / D1) + 0.9375;
  return N1 * (t - 2.625 / D1) * (t - 2.625 / D1) + 0.984375;
});
export const ease_in_bounce = unitInterval((t) => 1 - ease_out_bounce(1 - t));
export const ease_in_out_bounce = unitInterval((t) => (t < 0.5
  ? (1 - ease_out_bounce(1 - 2 * t)) / 2
  : (1 + ease_out_bounce(2 * t - 1)) / 2));

/** The rate functions by the names the scene plan uses ("smooth", "rate_functions.ease_out_bounce"). */
export const RATE_FUNCTIONS = {
  linear, smooth, smoothstep, smootherstep, smoothererstep, rush_into, rush_from, slow_into, double_smooth,
  there_and_back, there_and_back_with_pause, running_start, wiggle, lingering, exponential_decay,
  ease_in_sine, ease_out_sine, ease_in_out_sine, ease_in_quad, ease_out_quad, ease_in_out_quad, ease_in_cubic,
  ease_out_cubic, ease_in_out_cubic, ease_in_quart, ease_out_quart, ease_in_out_quart, ease_in_quint,
  ease_out_quint, ease_in_out_quint, ease_in_expo, ease_out_expo, ease_in_out_expo, ease_in_circ, ease_out_circ,
  ease_in_out_circ, ease_in_back, ease_out_back, ease_in_out_back, ease_in_elastic, ease_out_elastic,
  ease_in_out_elastic, ease_in_bounce, ease_out_bounce, ease_in_out_bounce,
};

export function rateFunction(name) {
  const key = String(name).replace(/^rate_functions\./, "");
  const f = RATE_FUNCTIONS[key];
  if (!f) throw new Error(`unknown rate function ${name}`);
  return f;
}
