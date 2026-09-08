// Resolves the name a downloaded Slack file should be saved under.
//
// Slack URLs rarely carry the real name: thumbnails come back as
// `image_720.png` and attachment links end in `/download`, so naming saves after
// the URL made every download collide on the same file. Treat those
// placeholders as "no name" and look for the real one in the page markup.
const ZlackDownloadNames = (function buildDownloadNames() {
  const GENERIC_NAME_RE = /^(?:image|img|file|files|download|downloads|attachment|blob|preview|thumb|thumbnail|untitled|unknown)(?:[-_ ]?\d+)?$/i;
  const FILE_NAME_SELECTOR = '[data-file-name], [data-qa="file_name"], .c-message_attachment__title, .p-file_details__name, .c-file__title';
  const MAX_NAME_LENGTH = 120;

  function cleanName(value) {
    if (typeof value !== 'string') return '';
    let name = value.trim();
    if (!name) return '';
    try {
      name = decodeURIComponent(name);
    } catch (_) { /* keep the raw value */ }
    name = name.split(/[\\/]/).pop();
    return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  }

  function extensionOf(name) {
    const match = /\.([A-Za-z0-9]{1,16})$/.exec(name || '');
    return match ? match[1].toLowerCase() : '';
  }

  function isGenericName(name) {
    if (!name) return true;
    const stem = name.replace(/\.[^.]+$/, '').trim();
    if (!stem) return true;
    if (/^\d+$/.test(stem)) return true;
    // Slack rewrites every non-ASCII byte of a name to `_` in the download URL
    // ("대리결재.fig" becomes "____________.fig"), which carries no name at all.
    if (/^[_\s.]+$/.test(stem)) return true;
    return GENERIC_NAME_RE.test(stem);
  }

  function isRealName(name) {
    return Boolean(name) && !isGenericName(name);
  }

  // An `alt` that ends in an extension is the file name itself, spaces included
  // ("Screen Shot 2026-01-02 at 10.11.12.png").
  function fileLikeName(value) {
    const text = cleanName(value);
    return text && extensionOf(text) ? text : '';
  }

  // Labels wrap the name in prose, and where the verb sits depends on the
  // language: `aria-label="Download report.pdf"` puts it first, Korean Slack
  // uses `aria-label="대리결재.fig 다운로드"`. Take the trailing filename-looking
  // token, else everything up to the first one.
  function fileLikeToken(value) {
    const text = cleanName(value);
    if (!text) return '';
    const trailing = /([^\s"'<>|:*?]+\.[A-Za-z0-9]{1,16})$/.exec(text);
    if (trailing) return trailing[1];
    const leading = /^([^"'<>|:*?]*?\.[A-Za-z0-9]{1,16})(?=\s)/.exec(text);
    return leading ? leading[1] : '';
  }

  function urlPathSegments(url, baseHref) {
    if (typeof url !== 'string' || !url) return [];
    try {
      const parsed = new URL(url, baseHref);
      return parsed.pathname.split('/').filter(Boolean).map(cleanName);
    } catch (_) {
      return [];
    }
  }

  // Walk the path backwards for a segment that actually looks like a file name
  // so both `/download/report.pdf` and a bare `/download` endpoint behave.
  function filenameFromUrl(url, baseHref) {
    const segments = urlPathSegments(url, baseHref);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (extensionOf(segments[i]) && isRealName(segments[i])) return segments[i];
    }
    const last = segments[segments.length - 1] || '';
    return isGenericName(last) ? '' : last;
  }

  // filename*=UTF-8''… wins over plain filename=…; both are optional because
  // cross-origin responses may not expose the header at all.
  function filenameFromContentDisposition(header) {
    if (!header) return '';
    const star = header.match(/filename\*\s*=\s*utf-8''([^;]+)/i);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch (_) { /* fall through to plain filename */ }
    }
    const quoted = header.match(/filename\s*=\s*"([^"]*)"/i);
    if (quoted) return quoted[1].trim();
    const bare = header.match(/filename\s*=\s*([^;]+)/i);
    return bare ? bare[1].trim() : '';
  }

  // Slack keeps the uploaded name next to the content: on the download link, on
  // the file card title, or in the image's alt/aria text. Climb a few levels
  // from the clicked element and take the first real name.
  function filenameFromElement(element, baseHref) {
    let node = element && element.nodeType === 1
      ? element
      : (element && element.parentElement) || null;

    for (let depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      const attribute = (name) => (node.getAttribute ? node.getAttribute(name) : null);

      for (const name of ['download', 'data-file-name']) {
        const candidate = cleanName(attribute(name));
        if (isRealName(candidate)) return candidate;
      }

      const alt = fileLikeName(attribute('alt'));
      if (isRealName(alt)) return alt;
      for (const name of ['aria-label', 'title']) {
        const token = fileLikeToken(attribute(name));
        if (isRealName(token)) return token;
      }

      // Subtree scans stay near the click; higher ancestors are whole message
      // lists where a query would be both slow and likely to match a
      // neighbouring attachment.
      if (depth < 4 && node.querySelector) {
        const labelled = node.querySelector(FILE_NAME_SELECTOR);
        if (labelled) {
          const candidate = cleanName(
            labelled.getAttribute('data-file-name') || labelled.textContent
          );
          if (isRealName(candidate)) return candidate;
        }
        const link = node.querySelector('a[download], a[href*="/download/"]');
        if (link) {
          const candidate = cleanName(link.getAttribute('download'))
            || filenameFromUrl(link.href, baseHref);
          if (isRealName(candidate)) return candidate;
        }
      }
    }
    return '';
  }

  function timestampedName(stem, extension, now = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return extension ? `${stem}-${stamp}.${extension}` : `${stem}-${stamp}`;
  }

  // Server-declared name first, then the page, then the URL; a timestamped
  // fallback keeps nameless saves distinct instead of piling up as "(1)", "(2)".
  function resolveFilename(options) {
    const { disposition, element, url, fallbackStem, baseHref, now } = options;
    const candidates = [
      cleanName(filenameFromContentDisposition(disposition)),
      filenameFromElement(element, baseHref),
      filenameFromUrl(url, baseHref),
    ];
    for (const candidate of candidates) {
      if (candidate) return candidate;
    }
    const segments = urlPathSegments(url, baseHref);
    const rawExtension = extensionOf(segments[segments.length - 1] || '');
    return timestampedName(fallbackStem, rawExtension, now);
  }

  return {
    cleanName,
    extensionOf,
    isGenericName,
    filenameFromUrl,
    filenameFromContentDisposition,
    filenameFromElement,
    timestampedName,
    resolveFilename,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZlackDownloadNames;
}
