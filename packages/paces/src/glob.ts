/** Minimal glob: `**` crosses separators, `*` does not, `?` is one character. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replaceAll('\\', '/');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** A process matches when a glob matches its script path or its whole command line. */
export function matchesProcess(argv: string[], globs: string[]): boolean {
  const script = (argv[1] ?? argv[0] ?? '').replaceAll('\\', '/');
  const line = argv.join(' ').replaceAll('\\', '/');
  return globs.some((g) => {
    const re = globToRegExp(g);
    return re.test(script) || re.test(line) || re.test(script.split('/').pop() ?? '');
  });
}

/** Include (when given) must match; exclude must not. */
export function shouldProfile(argv: string[], include: string[], exclude: string[]): boolean {
  if (include.length > 0 && !matchesProcess(argv, include)) return false;
  return !(exclude.length > 0 && matchesProcess(argv, exclude));
}
