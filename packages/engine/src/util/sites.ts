// "Same site" for browser code: the registrable domain, by the public suffix list (bbc.co.uk, not
// co.uk). `--first-party` is the override for the sites this still misjudges.

import { getDomain } from 'tldts';
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
  // Private suffixes count too, so alice.github.io and bob.github.io are different sites.
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** True when a script belongs to the site the run started on, an inferred app site, or matches an extra glob. */
export function isFirstParty(
  scriptUrl: string,
  launchedUrl: string,
  extra: string[],
  appSites: readonly string[] = [],
): boolean {
  for (const glob of extra) {
    try {
      if (globToRegExp(glob).test(scriptUrl)) return true;
    } catch {
      // An invalid glob matches nothing.
    }
  }
  const site = siteOf(scriptUrl);
  return site !== '' && (site === siteOf(launchedUrl) || appSites.includes(site));
}

export interface SiteUsage {
  selfUs: number;
  functions: number;
}

/** A site is the app's own when it does at least this share of all script time. */
const APP_SITE_TIME_SHARE = 0.5;
/** ...and serves at least this many times the functions the launched site does, and not a handful. */
const APP_SITE_FUNCTION_RATIO = 3;
const APP_SITE_MIN_FUNCTIONS = 50;

/**
 * Many sites serve their own bundle from a CDN on another domain (linkedin.com from licdn.com). When
 * the launched site serves little code and one other site serves most of the running code, that site is
 * the page's app, not a third party; otherwise every function would fold into one "dependency".
 * Returns at most one site. `--first-party` stays the way to say it explicitly.
 */
export function inferAppSites(
  usage: ReadonlyMap<string, SiteUsage>,
  launchedSite: string,
): string[] {
  let total = 0;
  for (const u of usage.values()) total += u.selfUs;
  if (total <= 0) return [];
  const own = usage.get(launchedSite);
  let best = '';
  let bestUs = 0;
  for (const [site, u] of usage) {
    if (site === launchedSite || u.selfUs <= bestUs) continue;
    best = site;
    bestUs = u.selfUs;
  }
  const top = usage.get(best);
  if (!top) return [];
  const enough =
    top.selfUs / total >= APP_SITE_TIME_SHARE &&
    top.functions >= APP_SITE_MIN_FUNCTIONS &&
    top.functions >= APP_SITE_FUNCTION_RATIO * (own?.functions ?? 0);
  return enough ? [best] : [];
}

/** The host of a URL, for naming a third party. */
export function hostOfUrl(url: string): string {
  return PARTS.exec(url)?.[2]?.toLowerCase() ?? '';
}
