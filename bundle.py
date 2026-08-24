"""
Build a single self-contained HTML file from the viz sources.

The published/shareable build cannot fetch anything -- no CDN scripts, no
XHR for the data -- so every dependency is inlined: D3, TopoJSON, the design
tokens, the scales, the app code, and both JSON payloads.

Output is written as page *content* (title + style + markup + scripts) with no
<!doctype>, <html>, <head> or <body> wrapper, because the artifact host
supplies those.

Usage:
    python bundle.py                       # -> dist/dl-map-standalone.html
    python bundle.py --full-document       # -> adds the html/head/body wrapper
                                           #    for opening straight off disk
"""

import argparse
import base64
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, 'dist')

TITLE = 'Digital Leaders Ranking — World Map'


def read(*parts):
    with open(os.path.join(HERE, *parts), encoding='utf-8') as handle:
        return handle.read()


def extract(html, tag):
    """Pull the inner text of the first <tag>...</tag> pair."""
    match = re.search(r'<%s[^>]*>(.*?)</%s>' % (tag, tag), html, re.S)
    return match.group(1) if match else ''


def inline_images(markup):
    """
    Replace <img src="./assets/x.svg"> with a data URI.

    A published page cannot fetch a relative asset, so any logo referenced by
    path would silently 404. Missing files are left alone -- the markup already
    hides an image that fails to load.
    """
    def replace(match):
        path = match.group(1)
        local = os.path.join(HERE, path.lstrip('./').replace('/', os.sep))
        if not os.path.exists(local):
            print('   note: %s not found, left as a path (the page hides it)' % path)
            return match.group(0)

        with open(local, 'rb') as handle:
            payload = base64.b64encode(handle.read()).decode('ascii')
        mime = 'image/svg+xml' if local.lower().endswith('.svg') else 'image/png'
        print('   inlined %s (%.1f KB)' % (path, os.path.getsize(local) / 1024))
        return 'src="data:%s;base64,%s"' % (mime, payload)

    return re.sub(r'src="(\./assets/[^"]+)"', replace, markup)


def body_markup(html):
    """Everything between <body> and </body>, minus the script tags."""
    inner = extract(html, 'body')
    inner = re.sub(r'<script.*?</script>', '', inner, flags=re.S).strip()
    return inline_images(inner)


def boot_script(html):
    """The last inline <script> in the source page -- the bootstrap block."""
    scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
    return scripts[-1] if scripts else ''


def build(full_document=False):
    index_html = read('index.html')

    data = json.loads(read('data', 'dl-data.json'))
    atlas = json.loads(read('data', 'countries-110m.json'))

    # separators without spaces keeps the payload as small as it can be
    embedded = json.dumps({'data': data, 'atlas': atlas},
                          ensure_ascii=False, separators=(',', ':'))

    parts = [
        '<title>%s</title>' % TITLE,
        # The brand face must be inlined: the source page links it from Google
        # Fonts, which a published page cannot reach.
        '<style>\n%s\n</style>' % read('vendor', 'montserrat.css'),
        # Lexend is the logo's typeface. The mark is inline SVG containing
        # live text, so without the font its hard-coded glyph positions break.
        '<style>\n%s\n</style>' % read('vendor', 'lexend.css'),
        '<style>\n%s\n</style>' % read('tokens.css'),
        '<style>\n%s\n</style>' % extract(index_html, 'style'),
        body_markup(index_html),
        '<script>%s</script>' % read('vendor', 'd3.v7.min.js'),
        '<script>%s</script>' % read('vendor', 'topojson.v3.min.js'),
        '<script>window.DL_EMBEDDED=%s;</script>' % embedded,
        '<script>\n%s\n</script>' % read('scales.js'),
        '<script>\n%s\n</script>' % read('index.js'),
        '<script>\n%s\n</script>' % boot_script(index_html),
    ]

    page = '\n\n'.join(parts)

    if full_document:
        page = ('<!doctype html>\n<html lang="en">\n<head>\n'
                '<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
                '</head>\n<body>\n%s\n</body>\n</html>' % page)

    return page


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--full-document', action='store_true',
                        help='wrap in html/head/body so it opens directly from disk')
    parser.add_argument('--output')
    args = parser.parse_args()

    page = build(full_document=args.full_document)

    output = args.output or os.path.join(
        DIST, 'dl-map-offline.html' if args.full_document else 'dl-map-standalone.html')
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, 'w', encoding='utf-8') as handle:
        handle.write(page)

    size_mb = os.path.getsize(output) / (1024 * 1024)
    print('wrote %s (%.2f MB)' % (output, size_mb))

    # Nothing may reach out to the network in a published page. The fetch
    # calls still appear in the source, but they sit behind the DL_EMBEDDED
    # guard -- so what matters is that the payload is present, not that the
    # dead branch is absent.
    problems = []
    for pattern, label in [(r'<script[^>]*\ssrc=', 'external <script src>'),
                           (r'<link[^>]*\shref="https?://', 'external <link>'),
                           (r'@import\s+url\(', 'CSS @import')]:
        if re.search(pattern, page):
            problems.append(label)

    if 'window.DL_EMBEDDED=' not in page:
        problems.append('embedded payload missing -- the page would fetch at runtime')

    for name, marker in [('D3', 'd3.select'), ('TopoJSON', 'topojson'),
                         ('Montserrat', "font-family: 'Montserrat'"),
                         ('Lexend', "font-family: 'Lexend'"),
                         ('the logo', 'id="dl-logo"')]:
        if marker not in page:
            problems.append('%s not inlined' % name)

    if problems:
        print('WARNING: %s' % '; '.join(problems))
    else:
        print('self-contained: libraries and both payloads inlined, no external requests')

    if size_mb > 16:
        print('WARNING: %.2f MB exceeds the 16 MB publish limit' % size_mb)


if __name__ == '__main__':
    main()
