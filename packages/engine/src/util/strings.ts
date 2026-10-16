export interface StringTable {
  strings: string[];
  /** Interns `s` and returns its stable index; the empty string is always 0. */
  intern(s: string): number;
}

export function createStringTable(): StringTable {
  const strings = [''];
  const index = new Map<string, number>([['', 0]]);
  return {
    strings,
    intern(s) {
      const found = index.get(s);
      if (found !== undefined) return found;
      const id = strings.length;
      strings.push(s);
      index.set(s, id);
      return id;
    },
  };
}
