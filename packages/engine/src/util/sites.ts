// "Same site" for browser code, without a public-suffix list: the last two labels of a host.
// `--first-party` is the override for the sites this misjudges (co.uk and friends).

import { globToRegExp } from './paths.js';

const PARTS = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)/i;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** `https://cdn.example.com:8080/a.js` -> `example.com`; `file:///x` -> `file://`; not a URL -> ''. */
export function siteOf(url: string): string {
  const match = PARTS.exec(url);
  if (!match) return '';
  const scheme = (match[1] ?? '').toLowerCase();
  const host = (match[2] ?? '').toLowerCase();
  if (scheme === 'file') return 'file://';
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') {
    return `${scheme}://${host}`;
  }
  if (IPV4.test(host) || host.startsWith('[') || !host.includes('.')) return host;
  return host.split('.').slice(-2).join('.');
}

/** True when a script belongs to the site the run started on, or matches an extra glob. */
export function isFirstParty(scriptUrl: string, launchedUrl: string, extra: string[]): boolean {
  for (const glob of extra) {
    try {
      if (globToRegExp(glob).test(scriptUrl)) return true;
    } catch {
      // An invalid glob matches nothing.
    }
  }
  const site = siteOf(scriptUrl);
  return site !== '' && site === siteOf(launchedUrl);
}

/** The host of a URL, for naming a third party. */
export function hostOfUrl(url: string): string {
  return PARTS.exec(url)?.[2]?.toLowerCase() ?? '';
}
