/**
 * eTLD+1 ("site") computation without a public-suffix list download.
 *
 * Fingerprinting defenses care about the *registrable domain*, because that is
 * what a tracker can join on: a.example.com and b.example.com are the same
 * site. We keep a compact snapshot of the multi-label public suffixes that
 * actually matter in practice, plus the algorithmic rules for the rest
 * (`*.co.uk`, `*.com.cn`, ...). Unknown two-label suffixes fall back to
 * "last two labels", which is the same behaviour as the PSL for the vast
 * majority of domains, and — importantly — fails *toward* stability: two
 * subdomains of an unrecognised suffix still agree.
 */

/**
 * Suffixes with more than one label, written in reverse-label order ("uk.co")
 * because that is how the PSL file lists them. They are normalised to the
 * host-name order ("co.uk") when the set is built, and every lookup below uses
 * host-name order — the mismatch between the two was a real bug that made
 * `example.co.uk` resolve to `co.uk`.
 */
const MULTI_LABEL_SUFFIXES_REVERSED = new Set<string>([
  // United Kingdom
  'uk.co', 'uk.org', 'uk.me', 'uk.ltd', 'uk.plc', 'uk.net', 'uk.ac', 'uk.gov', 'uk.sch',
  // China
  'cn.com', 'cn.net', 'cn.org', 'cn.gov', 'cn.edu', 'cn.ac', 'cn.mil',
  'bj.cn', 'sh.cn', 'tj.cn', 'cq.cn', 'he.cn', 'sx.cn', 'nm.cn', 'ln.cn', 'jl.cn',
  'hl.cn', 'js.cn', 'zj.cn', 'ah.cn', 'fj.cn', 'jx.cn', 'sd.cn', 'ha.cn', 'hb.cn',
  'hn.cn', 'gd.cn', 'gx.cn', 'hi.cn', 'sc.cn', 'gz.cn', 'yn.cn', 'xz.cn', 'sn.cn',
  'gs.cn', 'qh.cn', 'nx.cn', 'xj.cn', 'tw.cn', 'hk.cn', 'mo.cn',
  // Japan / Korea / Taiwan / HK
  'jp.co', 'jp.ne', 'jp.or', 'jp.ac', 'jp.go', 'jp.lg',
  'kr.co', 'kr.or', 'kr.ne', 'kr.ac', 'kr.go', 'kr.re',
  'tw.com', 'tw.net', 'tw.org', 'tw.edu', 'tw.gov', 'tw.idv',
  'hk.com', 'hk.net', 'hk.org', 'hk.edu', 'hk.gov', 'hk.idv',
  'mo.com', 'mo.net', 'mo.org', 'mo.edu', 'mo.gov',
  // Australia / NZ / Singapore / India / South Africa / Brazil
  'au.com', 'au.net', 'au.org', 'au.edu', 'au.gov', 'au.id',
  'nz.co', 'nz.net', 'nz.org', 'nz.ac', 'nz.gov',
  'sg.com', 'sg.net', 'sg.org', 'sg.edu', 'sg.gov',
  'in.co', 'in.net', 'in.org', 'in.gov', 'in.ac', 'in.edu',
  'za.co', 'za.net', 'za.org', 'za.gov', 'za.ac',
  'br.com', 'br.net', 'br.org', 'br.gov', 'br.edu',
  // Europe
  'de.com', 'de.net', 'de.org',
  'fr.com', 'fr.net', 'fr.org', 'fr.eu',
  'es.com', 'es.net', 'es.org', 'es.edu', 'es.gov',
  'it.com', 'it.net', 'it.org', 'it.edu', 'it.gov',
  'nl.com', 'nl.net', 'nl.org', 'nl.eu',
  'se.com', 'se.net', 'se.org', 'se.eu',
  'no.com', 'no.net', 'no.org',
  'fi.com', 'fi.net', 'fi.org',
  'dk.com', 'dk.net', 'dk.org',
  'pl.com', 'pl.net', 'pl.org',
  'ch.com', 'ch.net', 'ch.org',
  'at.com', 'at.net', 'at.org',
  'be.com', 'be.net', 'be.org', 'be.eu',
  'ie.com', 'ie.net', 'ie.org', 'ie.eu',
  'pt.com', 'pt.net', 'pt.org',
  'gr.com', 'gr.net', 'gr.org',
  'cz.com', 'cz.net', 'cz.org',
  'ru.com', 'ru.net', 'ru.org', 'ru.su',
  'ua.com', 'ua.net', 'ua.org',
  // Americas / misc
  'us.com', 'us.net', 'us.org', 'us.gov', 'us.edu',
  'ca.com', 'ca.net', 'ca.org',
  'mx.com', 'mx.net', 'mx.org',
  'ar.com', 'ar.net', 'ar.org',
  'cl.com', 'cl.net', 'cl.org',
  'co.com', 'co.net', 'co.org', 'co.edu', 'co.gov',
  'pe.com', 'pe.net', 'pe.org',
  've.com', 've.net', 've.org',
  // Middle East / Africa
  'ae.com', 'ae.net', 'ae.org', 'ae.ac',
  'il.com', 'il.net', 'il.org', 'il.ac',
  'tr.com', 'tr.net', 'tr.org', 'tr.edu', 'tr.gov',
  'eg.com', 'eg.net', 'eg.org',
  'sa.com', 'sa.net', 'sa.org',
  'ke.co', 'ke.org', 'ke.ac',
  'ng.com', 'ng.net', 'ng.org',
]);

/** Single-label suffixes that are "public" in the PSL sense (no registrable
 *  name extraction possible beyond one extra label). */
const SIMPLE_SUFFIXES = new Set<string>([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro',
  'xyz', 'top', 'site', 'online', 'club', 'shop', 'store', 'app', 'dev', 'io',
  'ai', 'co', 'me', 'tv', 'cc', 'ws', 'fm', 'gg', 'to', 'sh', 'ac', 'ly', 'us',
  'uk', 'de', 'fr', 'jp', 'cn', 'ru', 'br', 'in', 'au', 'ca', 'it', 'nl', 'se',
  'no', 'fi', 'dk', 'pl', 'es', 'pt', 'gr', 'cz', 'ch', 'at', 'be', 'ie', 'kr',
  'tw', 'hk', 'mo', 'sg', 'nz', 'za', 'mx', 'ar', 'cl', 'pe', 've', 'tr', 'il',
  'ae', 'sa', 'eg', 'ng', 'ke', 'ua', 'bg', 'ro', 'hu', 'sk', 'si', 'hr', 'ee',
  'lv', 'lt', 'is', 'lu', 'mt', 'cy',
]);

const MULTI_LABEL_SUFFIXES = new Set(
  [...MULTI_LABEL_SUFFIXES_REVERSED].map((s) => s.split('.').reverse().join('.')),
);

/**
 * Returns the registrable domain for a hostname, or null for values that have
 * no site identity (IP literals, localhost, single labels, extension origins).
 *
 * IP literals deliberately get no site: an attacker hosting on 203.0.113.7
 * shouldn't be able to correlate with 203.0.113.8, and there's no registry
 * anyway. They are treated as their own site by `siteKeyOf`.
 */
export function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || host.includes(':')) return null; // IPv6 literal
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (labels.every((l) => /^\d+$/.test(l))) return null; // IPv4 literal

  // Find the longest matching public suffix (checking up to 3 labels).
  for (let n = Math.min(3, labels.length - 1); n >= 2; n--) {
    const candidate = labels.slice(-n).join('.');
    if (MULTI_LABEL_SUFFIXES.has(candidate) || isWildcardSuffix(candidate)) {
      if (labels.length <= n) return null;
      return labels.slice(-(n + 1)).join('.');
    }
  }
  const tld = labels[labels.length - 1]!;
  if (labels.length === 2 && SIMPLE_SUFFIXES.has(tld)) return host;
  if (labels.length > 2) return labels.slice(-2).join('.');
  // Two labels with an unknown TLD: treat the last two as the site.
  return labels.length >= 2 ? labels.slice(-2).join('.') : null;
}

/** Wildcard suffix rules of the form "*.ck" (the PSL's wildcard entries). */
const WILDCARD_TLDS = new Set(['ck', 'fk', 'jm', 'kh', 'mm', 'np', 'pg', 'bd', 'er', 'fk']);
function isWildcardSuffix(candidate: string): boolean {
  const labels = candidate.split('.');
  return labels.length === 2 && WILDCARD_TLDS.has(labels[0]!);
}

/**
 * The identity used for profile derivation. Differs from
 * `registrableDomain` in that things without a registrable domain still get a
 * stable key of their own rather than sharing a bucket with all of them.
 */
export function siteKeyOf(url: { protocol: string; hostname: string }): string {
  if (url.hostname === '') return `${url.protocol}//opaque`;
  const rd = registrableDomain(url.hostname);
  return rd ?? `host:${url.hostname.toLowerCase()}`;
}
