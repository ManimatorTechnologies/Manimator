// Calling the ports the way Python code calls Manim: Cls(*args, **kwargs).

/** Maps positional `args` onto the names in `Cls.SIG` ("*name" takes the rest) and makes the object. */
export function pyCall(Cls, args = [], kwargs = {}) {
  return Cls.make(pyKwargs(Cls, args, kwargs));
}

export function pyKwargs(Cls, args = [], kwargs = {}) {
  const sig = Cls.SIG ?? [];
  const kw = { ...kwargs };
  let i = 0;
  for (const name of sig) {
    if (name.startsWith("*")) {
      kw[name.slice(1)] = args.slice(i);
      i = args.length;
      break;
    }
    if (i >= args.length) break;
    if (name in kwargs) throw new TypeError(`${Cls.name}() got multiple values for argument '${name}'`);
    kw[name] = args[i];
    i += 1;
  }
  if (i < args.length) {
    throw new TypeError(`${Cls.name}() takes ${i} positional arguments but ${args.length} were given`);
  }
  return kw;
}
