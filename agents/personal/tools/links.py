#!/usr/bin/env python3
"""links — the personal agent's link library. Stdlib only (python3 >= 3.9).

Code does the deterministic part: capture, fetch, extract, store, search, map.
The agent does the judgement: summary, tags, kind, why it's worth keeping (`annotate`).

  links.py add URL... [--note TEXT] [--tags a,b] [--kind K] [--no-fetch]
  links.py inbox [--file PATH]          ingest the phone inbox (one URL per line, text after it is a note)
  links.py enrich [ID...] [--pending] [--force]
  links.py annotate ID [--summary S] [--why W] [--tags a,b] [--kind K] [--status S] [--set field=value ...]
  links.py text ID [--file PATH] [--via NAME]   store page text read elsewhere (e.g. jev-browser), stdin by default
  links.py transcribe ID... [--max-min N]   download a video's audio (yt-dlp) and transcribe it locally (mlx-whisper)
  links.py show ID [--content]
  links.py search QUERY [--kind K] [--tag T] [--limit N]
  links.py list [--kind K] [--tag T] [--status S] [--todo] [--limit N]
  links.py places [--city C] [--near LAT,LON] [--km N] [--all]
  links.py map [ID...] [--city C] [--tag T] [--title T] [--hermes] [--out PATH] [--png] [--open]
  links.py plan FILE.json [--open]      render a curated day plan as a designed card (HTML + phone PNG)
  links.py page [--out PATH] [--open]    the whole library as one browsable HTML page (search, filters, map)
  links.py weather (--at LAT,LON | --place ID) [--date YYYY-MM-DD]   forecast for trip planning (Open-Meteo)
  links.py import-hermes                  one-time copy of ~/.hermes/places.db into the library
  links.py notion [--parent PAGE_ID] [--all]   push new/changed links to the Notion "Links" database (auto after writes)
  links.py export [--format md|json]
  links.py stats

Data: $PERSONAL_DATA or <agent>/data (links.db, snapshots/, maps/). Output is JSON unless noted.
"""
import argparse
import datetime as dt
import gzip
import html
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Runs from a pinned package snapshot (hq-pkg); state lives in the agent's folder under the state root, which .home
# names. Run from the live package: $HQ_STATE, else ~/.hq, else the package itself. Not HQ_AGENT_HOME: another agent
# running this tool would point it at its own home.
def _home(name):
    if os.path.exists(os.path.join(PKG_DIR, '.home')):
        return open(os.path.join(PKG_DIR, '.home')).read().strip()
    dot = os.path.expanduser('~/.hq')
    state = os.environ.get('HQ_STATE') or (dot if os.path.isdir(dot) else '')
    return os.path.join(state, 'agents', name) if state else PKG_DIR


AGENT_DIR = _home('personal')
DATA = os.environ.get('PERSONAL_DATA') or os.path.join(AGENT_DIR, 'data')
DB = os.path.join(DATA, 'links.db')
ICLOUD_INBOX = os.path.expanduser('~/Library/Mobile Documents/com~apple~CloudDocs/hq/inbox.txt')
INBOX = os.environ.get('PERSONAL_INBOX') or ICLOUD_INBOX
HERMES_PLACES = os.path.expanduser('~/.hermes/places.db')
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
MAX_BYTES = 3_000_000
MAX_CONTENT = 200_000

KINDS = ['article', 'video', 'place', 'event', 'product', 'repo', 'tool', 'recipe', 'post', 'paper', 'other']
STATUSES = ['saved', 'read', 'done', 'been', 'archived']

SCHEMA = """
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  final_url TEXT, domain TEXT,
  kind TEXT, status TEXT NOT NULL DEFAULT 'saved',
  title TEXT, site TEXT, description TEXT, author TEXT, published TEXT, image TEXT, lang TEXT,
  content TEXT, jsonld TEXT, meta TEXT,
  name TEXT, address TEXT, area TEXT, city TEXT, country TEXT, lat REAL, lon REAL,
  phone TEXT, hours TEXT, price TEXT, cuisine TEXT, rating TEXT, website TEXT, maps_url TEXT,
  starts_at TEXT, ends_at TEXT, venue TEXT,
  summary TEXT, why TEXT, tags TEXT, note TEXT, pinned TEXT,
  source TEXT, fetch_status TEXT, fetch_error TEXT,
  added_at TEXT NOT NULL, enriched_at TEXT, annotated_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_kind ON links(kind);
CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
CREATE INDEX IF NOT EXISTS idx_links_city ON links(city);
CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
  title, description, summary, why, tags, note, name, address, city, content,
  content='links', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS links_ai AFTER INSERT ON links BEGIN
  INSERT INTO links_fts(rowid, title, description, summary, why, tags, note, name, address, city, content)
  VALUES (new.id, new.title, new.description, new.summary, new.why, new.tags, new.note, new.name, new.address, new.city, new.content);
END;
CREATE TRIGGER IF NOT EXISTS links_ad AFTER DELETE ON links BEGIN
  INSERT INTO links_fts(links_fts, rowid, title, description, summary, why, tags, note, name, address, city, content)
  VALUES ('delete', old.id, old.title, old.description, old.summary, old.why, old.tags, old.note, old.name, old.address, old.city, old.content);
END;
CREATE TRIGGER IF NOT EXISTS links_au AFTER UPDATE ON links BEGIN
  INSERT INTO links_fts(links_fts, rowid, title, description, summary, why, tags, note, name, address, city, content)
  VALUES ('delete', old.id, old.title, old.description, old.summary, old.why, old.tags, old.note, old.name, old.address, old.city, old.content);
  INSERT INTO links_fts(rowid, title, description, summary, why, tags, note, name, address, city, content)
  VALUES (new.id, new.title, new.description, new.summary, new.why, new.tags, new.note, new.name, new.address, new.city, new.content);
END;
"""

# Fields the agent may set through `annotate --set`.
SETTABLE = {'title', 'kind', 'status', 'summary', 'why', 'tags', 'note', 'name', 'address', 'area', 'city',
            'country', 'lat', 'lon', 'phone', 'hours', 'price', 'cuisine', 'rating', 'starts_at', 'ends_at',
            'venue', 'author', 'published', 'description', 'website', 'maps_url'}


def now():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def db():
    os.makedirs(DATA, exist_ok=True)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    # Add columns introduced after a library was created.
    have = {r[1] for r in con.execute('PRAGMA table_info(links)')}
    for col in ('website', 'maps_url', 'pinned', 'notion_id', 'notion_synced_at'):
        if col not in have:
            con.execute(f'ALTER TABLE links ADD COLUMN {col} TEXT')
    return con


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def die(msg, code=1):
    print(f'links: {msg}', file=sys.stderr)
    sys.exit(code)


def norm_tags(raw):
    if not raw:
        return None
    tags = [t.strip().lower().replace(' ', '-') for t in re.split(r'[,#]', raw) if t.strip()]
    return ','.join(dict.fromkeys(tags)) or None


def merge_tags(old, new):
    return norm_tags(','.join(x for x in (old, new) if x))


def normalize_url(url):
    url = url.strip().strip('<>').strip()
    if not re.match(r'^[a-z][a-z0-9+.-]*://', url, re.I):
        url = 'https://' + url
    p = urllib.parse.urlsplit(url)
    if p.scheme.lower() not in ('http', 'https') or not p.netloc:
        raise ValueError(f'only http(s) links: {url}')   # file://, data:, ftp: would read local files into the library
    drop = re.compile(r'^(utm_|fbclid$|gclid$|igshid$|mc_|ref_src$|si$)')
    query = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True) if not drop.match(k)]
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or '/', urllib.parse.urlencode(query), ''))


def domain_of(url):
    host = urllib.parse.urlsplit(url).netloc.lower()
    return host[4:] if host.startswith('www.') else host


# ---------- fetch + extract ----------

class Page(HTMLParser):
    """Collects title, meta tags, JSON-LD blocks, canonical/icon links and readable text."""
    SKIP = {'script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'form', 'aside', 'iframe', 'template'}
    BLOCK = {'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'tr', 'section', 'article', 'blockquote', 'pre'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.links, self.jsonld, self.text = {}, {}, [], []
        self.title, self.lang, self.h1 = '', '', ''
        self._skip, self._in_title, self._in_h1, self._ld = 0, False, False, None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or '') for k, v in attrs}
        if tag == 'html' and a.get('lang'):
            self.lang = a['lang']
        elif tag == 'meta':
            key = (a.get('property') or a.get('name') or a.get('itemprop') or '').lower()
            if key and a.get('content') and key not in self.meta:
                self.meta[key] = a['content'].strip()
        elif tag == 'link':
            rel = a.get('rel', '').lower()
            if rel and a.get('href') and rel not in self.links:
                self.links[rel] = a['href']
        elif tag == 'script' and 'ld+json' in a.get('type', '').lower():
            self._ld = []
        if tag == 'title':
            self._in_title = True
        if tag == 'h1':
            self._in_h1 = True
        if tag in self.SKIP:
            self._skip += 1
        if tag in self.BLOCK:
            self.text.append('\n')

    def handle_endtag(self, tag):
        if tag == 'script' and self._ld is not None:
            self.jsonld.append(''.join(self._ld))
            self._ld = None
        if tag == 'title':
            self._in_title = False
        if tag == 'h1':
            self._in_h1 = False
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        if tag in self.BLOCK:
            self.text.append('\n')

    def handle_data(self, data):
        if self._ld is not None:
            self._ld.append(data)
            return
        if self._in_title:
            self.title += data
        if self._in_h1 and not self.h1:
            self.h1 = data.strip()
        if not self._skip:
            self.text.append(data)

    def readable(self):
        raw = ''.join(self.text)
        lines = [re.sub(r'\s+', ' ', ln).strip() for ln in raw.split('\n')]
        # Keep lines that look like prose or headings; drop menu crumbs.
        kept = [ln for ln in lines if len(ln) > 40 or (len(ln) > 3 and ln[-1:] in '.:?!')]
        return '\n'.join(kept)[:MAX_CONTENT]


# Meta sites serve the full caption, author and date only to link-preview crawlers.
CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
CRAWLER_DOMAINS = ('instagram.com', 'facebook.com', 'fb.watch', 'threads.net', 'threads.com')


def fetch(url, timeout=20):
    if urllib.parse.urlsplit(url).scheme.lower() not in ('http', 'https'):
        raise ValueError(f'only http(s) links: {url}')
    crawler = any(domain_of(url) == d or domain_of(url).endswith('.' + d) for d in CRAWLER_DOMAINS)
    req = urllib.request.Request(url, headers={
        'User-Agent': CRAWLER_UA if crawler else UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en,zh-TW;q=0.8'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read(MAX_BYTES)
        if r.headers.get('Content-Encoding') == 'gzip':
            body = gzip.decompress(body)
        charset = r.headers.get_content_charset() or 'utf-8'
        return r.geturl(), r.status, r.headers.get_content_type(), body.decode(charset, errors='replace')


def get_json(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': 'hq-personal-links/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', errors='replace'))


def flatten_ld(blocks):
    items = []

    def walk(x):
        if isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            if '@graph' in x:
                walk(x['@graph'])
            if '@type' in x:
                items.append(x)
    for b in blocks:
        try:
            walk(json.loads(b.strip()))
        except ValueError:
            continue
    return items


def ld_types(item):
    t = item.get('@type')
    return {s.lower() for s in (t if isinstance(t, list) else [t]) if isinstance(s, str)}


def text_of(v):
    if isinstance(v, dict):
        return v.get('name') or v.get('@id') or ''
    if isinstance(v, list):
        return ', '.join(filter(None, (text_of(x) for x in v)))
    return str(v) if v is not None else ''


PLACE_TYPES = {'place', 'localbusiness', 'restaurant', 'foodestablishment', 'cafeorcoffeeshop', 'barorpub',
               'bakery', 'touristattraction', 'museum', 'park', 'lodgingbusiness', 'hotel', 'store',
               'landmarksorhistoricalbuildings', 'nightclub', 'artgallery', 'winery', 'brewery', 'zoo', 'aquarium'}
ARTICLE_TYPES = {'article', 'newsarticle', 'blogposting', 'techarticle', 'report', 'scholarlyarticle'}


def from_ld(items):
    f = {}
    for it in items:
        types = ld_types(it)
        if types & PLACE_TYPES:
            f.setdefault('kind', 'place')
            f.setdefault('name', text_of(it.get('name')))
            addr = it.get('address')
            if isinstance(addr, dict):
                parts = [addr.get(k) for k in ('streetAddress', 'addressLocality', 'postalCode', 'addressCountry')]
                f.setdefault('address', ', '.join(text_of(p) for p in parts if p))
                if addr.get('addressLocality'):
                    f.setdefault('city', text_of(addr['addressLocality']))
                if addr.get('addressCountry'):
                    f.setdefault('country', text_of(addr['addressCountry']))
            elif addr:
                f.setdefault('address', text_of(addr))
            geo = it.get('geo') or {}
            if isinstance(geo, dict) and geo.get('latitude') and geo.get('longitude'):
                f.setdefault('lat', float(geo['latitude']))
                f.setdefault('lon', float(geo['longitude']))
            for src, dst in (('telephone', 'phone'), ('priceRange', 'price'), ('servesCuisine', 'cuisine')):
                if it.get(src):
                    f.setdefault(dst, text_of(it[src]))
            hours = it.get('openingHours') or it.get('openingHoursSpecification')
            if hours:
                f.setdefault('hours', json.dumps(hours, ensure_ascii=False) if not isinstance(hours, str) else hours)
            rating = it.get('aggregateRating')
            if isinstance(rating, dict) and rating.get('ratingValue'):
                f.setdefault('rating', f"{rating['ratingValue']} ({rating.get('reviewCount') or rating.get('ratingCount') or '?'})")
        if 'event' in types or any(t.endswith('event') for t in types):
            f.setdefault('kind', 'event')
            f.setdefault('name', text_of(it.get('name')))
            f.setdefault('starts_at', text_of(it.get('startDate')))
            f.setdefault('ends_at', text_of(it.get('endDate')))
            loc = it.get('location')
            if isinstance(loc, list):
                loc = loc[0] if loc else None
            if isinstance(loc, dict):
                f.setdefault('venue', text_of(loc.get('name')))
                addr = loc.get('address')
                if isinstance(addr, dict):
                    f.setdefault('address', ', '.join(text_of(addr.get(k)) for k in ('streetAddress', 'addressLocality') if addr.get(k)))
                    if addr.get('addressLocality'):
                        f.setdefault('city', text_of(addr['addressLocality']))
                geo = loc.get('geo') or {}
                if isinstance(geo, dict) and geo.get('latitude'):
                    f.setdefault('lat', float(geo['latitude']))
                    f.setdefault('lon', float(geo['longitude']))
        if types & ARTICLE_TYPES:
            f.setdefault('kind', 'paper' if 'scholarlyarticle' in types else 'article')
            f.setdefault('author', text_of(it.get('author')))
            f.setdefault('published', text_of(it.get('datePublished')))
        if 'recipe' in types:
            f.setdefault('kind', 'recipe')
        if 'product' in types:
            f.setdefault('kind', 'product')
            offers = it.get('offers')
            if isinstance(offers, list):
                offers = offers[0] if offers else None
            if isinstance(offers, dict) and offers.get('price'):
                f.setdefault('price', f"{offers.get('price')} {offers.get('priceCurrency', '')}".strip())
        if 'videoobject' in types:
            f.setdefault('kind', 'video')
            f.setdefault('published', text_of(it.get('uploadDate')))
    return {k: v for k, v in f.items() if v not in ('', None)}


def maps_fields(url):
    """Google / Apple Maps URLs carry the place in the URL itself."""
    f = {}
    p = urllib.parse.urlsplit(url)
    q = dict(urllib.parse.parse_qsl(p.query))
    if 'google.' in p.netloc and '/maps' in p.path:
        f['kind'] = 'place'
        m = re.search(r'/(?:place|search)/([^/@]+)', p.path)
        if m:
            f['name'] = urllib.parse.unquote_plus(m.group(1))
        m = re.search(r'!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)', url) or re.search(r'@(-?\d+\.\d+),(-?\d+\.\d+)', url)
        if m:
            f['lat'], f['lon'] = float(m.group(1)), float(m.group(2))
        if (q.get('q') or q.get('query')) and 'name' not in f:
            f['name'] = q.get('q') or q.get('query')
    elif p.netloc.endswith('maps.apple.com'):
        f['kind'] = 'place'
        if q.get('q'):
            f['name'] = q['q']
        ll = q.get('ll') or q.get('coordinate') or q.get('sll')
        if ll and ',' in ll:
            a, b = ll.split(',')[:2]
            f['lat'], f['lon'] = float(a), float(b)
        if q.get('address'):
            f['address'] = q['address']
    return f


def url_kind(url):
    d = domain_of(url)
    path = urllib.parse.urlsplit(url).path
    if d in ('youtube.com', 'youtu.be', 'm.youtube.com', 'vimeo.com', 'fb.watch') or d.endswith('.youtube.com') \
            or re.match(r'/(reels?|watch|tv)/', path) or '/videos/' in path:
        return 'video'
    if d in ('github.com', 'gitlab.com', 'codeberg.org') and path.count('/') >= 2:
        return 'repo'
    if d in ('arxiv.org', 'openreview.net', 'biorxiv.org') or d.endswith('.acm.org'):
        return 'paper'
    if d in ('x.com', 'twitter.com', 'threads.net', 'bsky.app', 'reddit.com', 'news.ycombinator.com', 'instagram.com', 'tiktok.com'):
        return 'post'
    if d in ('lu.ma', 'luma.com', 'eventbrite.com', 'eventbrite.co.uk', 'meetup.com', 'partiful.com') or d.endswith('.eventbrite.com'):
        return 'event'
    return None


def oembed(url):
    d = domain_of(url)
    endpoint = None
    if d in ('youtube.com', 'youtu.be', 'm.youtube.com'):
        endpoint = 'https://www.youtube.com/oembed?format=json&url='
    elif d == 'vimeo.com':
        endpoint = 'https://vimeo.com/api/oembed.json?url='
    if not endpoint:
        return {}
    try:
        o = get_json(endpoint + urllib.parse.quote(url, safe=''))
    except (urllib.error.URLError, ValueError, OSError):
        return {}
    return {k: v for k, v in {'title': o.get('title'), 'author': o.get('author_name'),
                              'image': o.get('thumbnail_url'), 'site': o.get('provider_name')}.items() if v}


_last_geocode = [0.0]


def geocode(query):
    """OpenStreetMap Nominatim (max 1 request/s). One retry keeps the name's first two words and the last (the town)."""
    import time
    words = query.replace(',', ' ').split()
    tries = [query] + ([' '.join(words[:2] + words[-1:])] if len(words) > 3 else [])
    res = None
    for q in dict.fromkeys(tries):
        wait = 1.1 - (time.time() - _last_geocode[0])
        if wait > 0:
            time.sleep(wait)
        _last_geocode[0] = time.time()
        try:
            res = get_json('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q='
                           + urllib.parse.quote(q))
        except (urllib.error.URLError, ValueError, OSError):
            res = None
        if res:
            break
    if not res:
        return {}
    r = res[0]
    a = r.get('address', {})
    return {'lat': float(r['lat']), 'lon': float(r['lon']),
            'city': a.get('city') or a.get('town') or a.get('village') or a.get('municipality'),
            'country': a.get('country'), 'area': a.get('suburb') or a.get('neighbourhood') or a.get('quarter')}


def extract(url, final_url, ctype, body):
    """Everything we can learn from one fetched page, as column values."""
    f = {'final_url': final_url, 'domain': domain_of(final_url)}
    if ctype == 'application/pdf':
        f['kind'] = 'paper'
        return f
    if 'html' not in ctype and 'xml' not in ctype:
        f['content'] = body[:MAX_CONTENT] if ctype.startswith('text/') else None
        return f
    page = Page()
    try:
        page.feed(body)
    except Exception:  # malformed HTML: keep what was parsed
        pass
    m = page.meta
    ld = flatten_ld(page.jsonld)
    f.update({
        'title': html.unescape(m.get('og:title') or m.get('twitter:title') or page.title.strip() or page.h1),
        'site': m.get('og:site_name') or m.get('application-name'),
        'description': m.get('og:description') or m.get('description') or m.get('twitter:description'),
        'author': m.get('author') or m.get('article:author') or m.get('twitter:creator'),
        'published': m.get('article:published_time') or m.get('date') or m.get('dc.date'),
        'image': m.get('og:image') or m.get('twitter:image'),
        'lang': page.lang,
        'content': page.readable(),
        'jsonld': json.dumps(ld, ensure_ascii=False)[:100_000] if ld else None,
        'meta': json.dumps(m, ensure_ascii=False)[:20_000],
    })
    og_type = (m.get('og:type') or '').lower()
    if og_type.startswith('video'):
        f['kind'] = 'video'
    elif og_type in ('article', 'blog'):
        f['kind'] = 'article'
    lat = m.get('place:location:latitude') or m.get('og:latitude')
    lon = m.get('place:location:longitude') or m.get('og:longitude')
    if lat and lon:
        f.update({'kind': 'place', 'lat': float(lat), 'lon': float(lon)})
    for k, v in from_ld(ld).items():
        if k == 'kind' or not f.get(k):
            f[k] = v
    # Instagram/Threads previews: "698K likes, 1,480 comments - eatclub.de on June 30, 2026: "caption""
    m = re.match(r'^\s*([\d.,KMB]+) likes?, ([\d.,KMB]+) comments? - ([\w.]+) on ([A-Z][a-z]+ \d{1,2}, \d{4})',
                 f.get('description') or '')
    if m:
        f['author'] = f.get('author') or '@' + m.group(3)
        f['published'] = f.get('published') or m.group(4)
        f['rating'] = f'{m.group(1)} likes, {m.group(2)} comments'
    if url_kind(final_url) in ('video', 'repo', 'paper', 'event'):
        f['kind'] = url_kind(final_url)
    return {k: v for k, v in f.items() if v not in ('', None)}


def snapshot(link_id, body):
    d = os.path.join(DATA, 'snapshots')
    os.makedirs(d, exist_ok=True)
    with gzip.open(os.path.join(d, f'{link_id}.html.gz'), 'wt', encoding='utf-8') as fh:
        fh.write(body)


def enrich_one(con, row, do_geocode=True):
    url = row['url']
    fields = {}
    try:
        final_url, status, ctype, body = fetch(url)
        fields = extract(url, final_url, ctype, body)
        if 'html' in ctype:
            snapshot(row['id'], body)
        fields['fetch_status'] = str(status)
        fields['fetch_error'] = None
    except urllib.error.HTTPError as e:
        fields = {'fetch_status': str(e.code), 'fetch_error': f'HTTP {e.code} {e.reason}', 'final_url': e.geturl() or url}
    except (urllib.error.URLError, OSError, ValueError) as e:
        fields = {'fetch_status': 'error', 'fetch_error': str(getattr(e, 'reason', e))[:300]}
    final = fields.get('final_url') or url
    # URL-borne facts win over guesses; a short maps link only reveals them after the redirect.
    for k, v in {**maps_fields(url), **maps_fields(final)}.items():
        fields[k] = v
    for k, v in oembed(final).items():
        fields.setdefault(k, v)
    if not fields.get('kind') and not row['kind']:
        fields['kind'] = url_kind(final) or ('article' if len(fields.get('content') or '') > 1500 else 'other')
    generic = {'google maps', 'apple maps', 'maps', ''}
    if fields.get('kind') == 'place' and fields.get('name') and (fields.get('title') or '').strip().lower() in generic:
        fields['title'] = fields['name']
    if (fields.get('description') or '').startswith(('Find local businesses, view maps', 'Search for places')):
        fields['description'] = None  # Maps' own blurb, not about the place
    is_place = (fields.get('kind') or row['kind']) == 'place'
    has_geo = fields.get('lat') is not None or row['lat'] is not None
    if do_geocode and is_place and not has_geo:
        q = fields.get('address') or row['address'] or ' '.join(filter(None, [fields.get('name') or row['name'], fields.get('city') or row['city']]))
        if q:
            for k, v in geocode(q).items():
                if v is not None and not (row[k] if k in row.keys() else None):
                    fields.setdefault(k, v)
    # Never overwrite what the agent or the user set by hand (annotate records those as pinned).
    pinned = set((row['pinned'] or '').split(','))
    fields = {k: v for k, v in fields.items() if k not in pinned}
    fields['enriched_at'] = now()
    update(con, row['id'], fields)
    return fields


def update(con, link_id, fields):
    if not fields:
        return
    fields = dict(fields, updated_at=now())
    cols = ', '.join(f'{k} = ?' for k in fields)
    con.execute(f'UPDATE links SET {cols} WHERE id = ?', [*fields.values(), link_id])
    con.commit()


# ---------- views ----------

BRIEF = ['id', 'kind', 'status', 'title', 'url', 'domain', 'tags', 'summary', 'note', 'city', 'added_at']


def brief(row, extra=()):
    d = {k: row[k] for k in (*BRIEF, *extra) if k in row.keys() and row[k] not in (None, '')}
    if d.get('summary') and len(d['summary']) > 240:
        d['summary'] = d['summary'][:237] + '...'
    return d


def full(row, with_content=False):
    d = {k: row[k] for k in row.keys() if row[k] not in (None, '') and k not in ('content', 'jsonld', 'meta')}
    content = row['content'] or ''
    d['content_chars'] = len(content)
    d['content' if with_content else 'content_preview'] = content if with_content else content[:1500]
    if row['jsonld']:
        d['jsonld_types'] = sorted({t for it in json.loads(row['jsonld']) for t in ld_types(it)})
    snap = os.path.join(DATA, 'snapshots', f"{row['id']}.html.gz")
    if os.path.exists(snap):
        d['snapshot'] = snap
    return d


def get_row(con, link_id):
    row = con.execute('SELECT * FROM links WHERE id = ?', (link_id,)).fetchone()
    if not row:
        die(f'no link {link_id}')
    return row


def filters(args, where, params):
    if getattr(args, 'kind', None):
        where.append('l.kind = ?')
        params.append(args.kind)
    if getattr(args, 'tag', None):
        where.append("(',' || l.tags || ',') LIKE ?")
        params.append(f'%,{args.tag.lower()},%')
    if getattr(args, 'status', None):
        where.append('l.status = ?')
        params.append(args.status)
    if getattr(args, 'city', None):
        where.append('lower(l.city) = lower(?)')
        params.append(args.city)


def km_between(a, b):
    r = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def hermes_places():
    if not os.path.exists(HERMES_PLACES):
        return []
    con = sqlite3.connect(f'file:{HERMES_PLACES}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("SELECT * FROM places WHERE status != 'closed'").fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()
    return [{'source': 'hermes', 'id': f"h{r['id']}", 'title': r['name'], 'name': r['name'], 'kind': 'place',
             'status': r['status'], 'lat': r['lat'], 'lon': r['lon'], 'address': r['address'], 'area': r['area'],
             'city': r['city'], 'cuisine': r['cuisine'], 'price': r['price'], 'note': r['note'], 'tags': r['tags'],
             'url': r['maps_url'] or r['website'] or r['source_url'], 'place_kind': r['kind']} for r in rows]


# ---------- commands ----------

def add_urls(con, items, source, kind=None, tags=None, fetch_now=True):
    added = []
    for url, note in items:
        try:
            nurl = normalize_url(url)
        except ValueError:
            added.append({'url': url, 'error': 'not a url'})
            continue
        existing = con.execute('SELECT * FROM links WHERE url = ? OR final_url = ?', (nurl, nurl)).fetchone()
        if existing:
            merged = {'tags': merge_tags(existing['tags'], tags)}
            if note:
                merged['note'] = f"{existing['note']}\n{note}" if existing['note'] else note
            update(con, existing['id'], {k: v for k, v in merged.items() if v})
            added.append({'id': existing['id'], 'url': nurl, 'duplicate': True})
            continue
        cur = con.execute(
            'INSERT INTO links (url, domain, kind, tags, note, source, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (nurl, domain_of(nurl), kind or maps_fields(nurl).get('kind') or url_kind(nurl), norm_tags(tags),
             note or None, source, now()))
        con.commit()
        link_id = cur.lastrowid
        entry = {'id': link_id, 'url': nurl}
        if fetch_now:
            f = enrich_one(con, get_row(con, link_id))
            entry.update({k: f[k] for k in ('kind', 'title', 'fetch_error') if f.get(k)})
        added.append(entry)
    return added


def cmd_add(con, a):
    items = [(u, a.note) for u in a.urls]
    out(add_urls(con, items, a.source, a.kind, a.tags, not a.no_fetch))


URL_RE = re.compile(r'https?://\S+|(?:www\.)\S+\.\S+')


def cmd_inbox(con, a):
    path = a.file or INBOX
    if not os.path.exists(path):
        out({'inbox': path, 'items': 0, 'hint': 'create it, or append from an iOS Shortcut (see the links skill)'})
        return
    with open(path, encoding='utf-8') as fh:
        lines = fh.read().splitlines()
    items, leftover = [], []
    for ln in lines:
        m = URL_RE.search(ln)
        if not m:
            if ln.strip():
                leftover.append(ln)
            continue
        note = (ln[:m.start()] + ln[m.end():]).strip(' -—:|\t') or None
        items.append((m.group(0).rstrip(').,;'), note))
    added = add_urls(con, items, 'inbox', fetch_now=not a.no_fetch)
    # Keep lines without a URL for the agent to look at; everything else has been ingested.
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(leftover) + ('\n' if leftover else ''))
    out({'inbox': path, 'added': added, 'left_without_url': leftover})


def cmd_enrich(con, a):
    if a.ids:
        rows = [get_row(con, i) for i in a.ids]
    elif a.pending:
        rows = con.execute("SELECT * FROM links WHERE enriched_at IS NULL OR fetch_status = 'error' ORDER BY id").fetchall()
    else:
        die('give IDs or --pending')
    res = []
    for r in rows:
        if r['enriched_at'] and not a.force and not a.pending:
            res.append({'id': r['id'], 'skipped': 'already enriched (use --force)'})
            continue
        f = enrich_one(con, r)
        res.append({'id': r['id'], **{k: f[k] for k in ('kind', 'title', 'fetch_status', 'fetch_error') if f.get(k)}})
    out(res)


def cmd_annotate(con, a):
    row = get_row(con, a.id)
    fields = {}
    for k in ('summary', 'why', 'kind', 'status', 'note', 'title'):
        v = getattr(a, k)
        if v is not None:
            fields[k] = v
    if a.tags is not None:
        fields['tags'] = norm_tags(a.tags) if a.replace_tags else merge_tags(row['tags'], a.tags)
    for kv in a.set or []:
        k, _, v = kv.partition('=')
        if k not in SETTABLE:
            die(f"can't set '{k}'; settable: {', '.join(sorted(SETTABLE))}")
        fields[k] = float(v) if k in ('lat', 'lon') and v else (v or None)
    if fields.get('maps_url'):
        for k, v in maps_fields(fields['maps_url']).items():
            if k != 'kind' and k not in fields:
                fields[k] = v
    if fields.get('kind') and fields['kind'] not in KINDS:
        die(f"kind must be one of {', '.join(KINDS)}")
    if fields.get('status') and fields['status'] not in STATUSES:
        die(f"status must be one of {', '.join(STATUSES)}")
    pins = set(filter(None, (row['pinned'] or '').split(','))) | (set(fields) & SETTABLE)
    fields['pinned'] = ','.join(sorted(pins))
    fields['annotated_at'] = now()
    update(con, a.id, fields)
    out(brief(get_row(con, a.id), ('why',)))


def cmd_text(con, a):
    get_row(con, a.id)
    text = open(a.file, encoding='utf-8').read() if a.file else sys.stdin.read()
    if not text.strip():
        die('no text given')
    update(con, a.id, {'content': text[:MAX_CONTENT], 'fetch_status': f'via {a.via}', 'fetch_error': None,
                       'enriched_at': now()})
    out({'id': a.id, 'content_chars': min(len(text), MAX_CONTENT), 'via': a.via})


TRANSCRIPT_MARK = '\n\n## Transcript\n'
COOKIES_BROWSER = os.environ.get('PERSONAL_COOKIES_BROWSER', 'chrome:Agent')
WHISPER_MODEL = os.environ.get('PERSONAL_WHISPER_MODEL', 'mlx-community/whisper-large-v3-turbo')


def transcribe_one(con, row, max_min):
    import shutil
    import tempfile
    uvx = shutil.which('uvx') or '/opt/homebrew/bin/uvx'
    url = row['final_url'] or row['url']
    with tempfile.TemporaryDirectory() as tmp:
        info = subprocess.run([uvx, 'yt-dlp', '--no-playlist', '-q', '--print', '%(duration)s', '--skip-download', url],
                              capture_output=True, text=True, timeout=120)
        try:
            minutes = float(info.stdout.strip().splitlines()[-1]) / 60
        except (ValueError, IndexError):
            minutes = 0
        if minutes > max_min:
            return {'id': row['id'], 'skipped': f'{minutes:.0f} min video; raise --max-min to transcribe it'}
        audio = os.path.join(tmp, 'a.m4a')
        base = [uvx, 'yt-dlp', '--no-playlist', '-q', '-x', '--audio-format', 'm4a', '-o', os.path.join(tmp, 'a.%(ext)s')]
        dl = subprocess.run(base + [url], capture_output=True, text=True, timeout=600)
        if not os.path.exists(audio) and COOKIES_BROWSER:
            # Logged-in only (Facebook, private reels): retry with the user's browser session.
            dl = subprocess.run(base + ['--cookies-from-browser', COOKIES_BROWSER, url], capture_output=True, text=True, timeout=600)
        if not os.path.exists(audio):
            return {'id': row['id'], 'error': 'download failed: ' + (dl.stderr.strip().splitlines() or ['?'])[-1][:200]}
        tr = subprocess.run([uvx, '--from', 'mlx-whisper', 'mlx_whisper', audio, '--model', WHISPER_MODEL,
                             '-f', 'txt', '-o', tmp, '--verbose', 'False'], capture_output=True, text=True, timeout=3600)
        txt = os.path.join(tmp, 'a.txt')
        if not os.path.exists(txt):
            return {'id': row['id'], 'error': 'transcription failed: ' + (tr.stderr.strip().splitlines() or ['?'])[-1][:200]}
        transcript = open(txt, encoding='utf-8').read().strip()
    content = (row['content'] or '').split(TRANSCRIPT_MARK)[0]
    update(con, row['id'], {'content': (content + TRANSCRIPT_MARK + transcript)[:MAX_CONTENT]})
    res = {'id': row['id'], 'minutes': round(minutes, 1), 'transcript_chars': len(transcript),
           'transcript_preview': transcript[:300]}
    # Speech runs ~800+ chars a minute; far less means music, and Whisper invents words over music.
    if minutes and len(transcript) < 250 * minutes + 60:
        res['likely_no_speech'] = True
    return res


def cmd_transcribe(con, a):
    out([transcribe_one(con, get_row(con, i), a.max_min) for i in a.ids])


def cmd_show(con, a):
    out([full(get_row(con, i), a.content) for i in a.ids])


def fts_query(q):
    # Plain words become prefix terms joined by AND; quoted phrases and FTS syntax pass through.
    if re.search(r'["*()]|\b(AND|OR|NOT|NEAR)\b', q):
        return q
    words = re.findall(r'\w+', q, re.UNICODE)
    return ' '.join(f'"{w}"*' for w in words)


def cmd_search(con, a):
    where, params = ['links_fts MATCH ?'], [fts_query(a.query)]
    filters(a, where, params)
    rows = con.execute(
        f"""SELECT l.*, snippet(links_fts, -1, '[', ']', '…', 12) AS hit
            FROM links_fts JOIN links l ON l.id = links_fts.rowid
            WHERE {' AND '.join(where)} ORDER BY bm25(links_fts, 10, 4, 6, 4, 6, 3, 6, 2, 2, 1) LIMIT ?""",
        [*params, a.limit]).fetchall()
    out([dict(brief(r), hit=r['hit']) for r in rows])


def cmd_list(con, a):
    where, params = ['1=1'], []
    filters(a, where, params)
    if a.todo:
        where.append('l.annotated_at IS NULL')
    if not a.status and not a.all:
        where.append("l.status != 'archived'")
    rows = con.execute(f"SELECT * FROM links l WHERE {' AND '.join(where)} ORDER BY l.id DESC LIMIT ?",
                       [*params, a.limit]).fetchall()
    out([brief(r) for r in rows])


def place_rows(con, a, ids=None):
    where, params = ["l.kind = 'place'"], []
    if ids:
        where.append(f"l.id IN ({','.join('?' * len(ids))})")
        params.extend(ids)
    else:
        filters(a, where, params)
        if not getattr(a, 'all', False):
            where.append("l.status NOT IN ('archived', 'done')")
    rows = [dict(r) for r in con.execute(f"SELECT * FROM links l WHERE {' AND '.join(where)}", params)]
    for r in rows:
        r['source'] = 'links'
    return rows


def cmd_places(con, a):
    rows = place_rows(con, a)
    if a.hermes:
        rows += [h for h in hermes_places() if not a.city or (h['city'] or '').lower() == a.city.lower()]
    keep = ['source', 'id', 'title', 'name', 'status', 'area', 'city', 'address', 'lat', 'lon', 'cuisine', 'price',
            'hours', 'rating', 'website', 'summary', 'why', 'note', 'tags', 'maps_url', 'url', 'place_kind']
    res = [{k: r.get(k) for k in keep if r.get(k) not in (None, '')} for r in rows]
    if a.near:
        here = tuple(float(x) for x in a.near.split(','))
        for r in res:
            if r.get('lat') is not None:
                r['km'] = round(km_between(here, (r['lat'], r['lon'])), 2)
        res = [r for r in res if 'km' in r and r['km'] <= a.km]
        res.sort(key=lambda r: r['km'])
    else:
        res.sort(key=lambda r: ((r.get('city') or '~').lower(), (r.get('area') or '~').lower()))
    out(res)


MAP_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  :root { --bg:#fbfaf7; --fg:#1d1c1a; --muted:#6b6862; --line:#e4e1da; --accent:#c2410c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151412; --fg:#ece9e3; --muted:#a19d95; --line:#2c2a26; --accent:#fb923c; } }
  * { box-sizing:border-box } body { margin:0; font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); display:grid; grid-template-columns:340px 1fr; height:100vh }
  aside { overflow:auto; border-right:1px solid var(--line); padding:16px }
  h1 { font-size:16px; margin:0 0 4px } .sub { color:var(--muted); margin:0 0 12px; font-size:12px }
  .p { padding:10px 0; border-top:1px solid var(--line); cursor:pointer } .p:hover .n { color:var(--accent) }
  .n { font-weight:600 } .m { color:var(--muted); font-size:12px } .w { margin-top:4px }
  #map { height:100vh } a { color:var(--accent) }
  @media (max-width:720px) { body { grid-template-columns:1fr; grid-template-rows:55vh 1fr } #map { height:55vh; order:-1 } aside { border:0 } }
  /* #card: the shareable picture (links map --png) */
  body.card { grid-template-columns:1fr; grid-template-rows:60vh 40vh; font-size:22px } body.card #map { height:60vh; order:-1 }
  body.card aside { border:0; padding:28px 36px; overflow:hidden } body.card h1 { font-size:34px } body.card .sub { font-size:18px; margin-bottom:16px }
  body.card .p { padding:14px 0 } body.card .m { font-size:17px } body.card .p .m:last-child { display:none }
  body.card .leaflet-control-zoom { display:none } body.card .leaflet-tooltip { font-size:20px; font-weight:700; padding:4px 10px }
</style></head><body>
<script>if (location.hash === '#card') document.body.classList.add('card');</script>
<aside><h1>__TITLE__</h1><p class="sub">__SUB__</p><div id="list"></div></aside>
<div id="map"></div>
<script>
const places = __DATA__;
const map = L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const markers = [], list = document.getElementById('list');
places.forEach((p, i) => {
  const meta = [p.area, p.city, p.cuisine, p.price, p.meta].filter(Boolean).join(' · ');
  const body = `<div class="n">${i + 1}. ${esc(p.title || p.name)}</div><div class="m">${esc(meta)}</div>` +
    (p.why || p.summary || p.note ? `<div class="w">${esc(p.why || p.summary || p.note)}</div>` : '') +
    (p.url ? `<div class="m"><a href="${esc(p.url)}" target="_blank" rel="noopener">open</a></div>` : '');
  const m = L.circleMarker([p.lat, p.lon], { radius: document.body.classList.contains('card') ? 14 : 8, color: p.source === 'hermes' ? '#2563eb' : '#c2410c', weight: 2, fillOpacity: .6 })
    .bindPopup(body).bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: '' }).addTo(map);
  markers.push(m);
  const row = document.createElement('div'); row.className = 'p'; row.innerHTML = body;
  row.onclick = () => { map.setView([p.lat, p.lon], 16); m.openPopup(); };
  list.appendChild(row);
});
if (markers.length) map.fitBounds(L.featureGroup(markers).getBounds().pad(0.15)); else map.setView([51.5, -0.12], 11);
</script></body></html>
"""


LIBRARY_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saved Library</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  :root { --bg:#fbfaf7; --card:#ffffff; --fg:#1d1c1a; --muted:#6b6862; --line:#e7e3dc; --chip:#f1eee8; --accent:#c2410c; --on-accent:#fff; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#141311; --card:#1c1b18; --fg:#ece9e3; --muted:#a19d95; --line:#2c2a26; --chip:#26241f; --accent:#fb923c; --on-accent:#1a0f05; } }
  * { box-sizing:border-box } html { -webkit-text-size-adjust:100% }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
  header { position:sticky; top:0; z-index:500; background:var(--bg); border-bottom:1px solid var(--line); padding:14px 16px 10px }
  .top { display:flex; gap:10px; align-items:center; max-width:1100px; margin:0 auto }
  h1 { font-size:17px; margin:0; white-space:nowrap } .count { color:var(--muted); font-size:13px; white-space:nowrap }
  input[type=search] { flex:1; min-width:0; font:inherit; padding:8px 12px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--fg) }
  .seg { display:flex; border:1px solid var(--line); border-radius:10px; overflow:hidden }
  .seg button { font:inherit; font-size:13px; border:0; background:var(--card); color:var(--fg); padding:7px 12px; cursor:pointer }
  .seg button.on { background:var(--accent); color:var(--on-accent) }
  .chips { display:flex; gap:6px; flex-wrap:wrap; max-width:1100px; margin:10px auto 0 }
  .chip { font:inherit; font-size:12px; border:1px solid transparent; background:var(--chip); color:var(--fg); border-radius:999px; padding:3px 10px; cursor:pointer }
  .chip.on { border-color:var(--accent); color:var(--accent) } .chip .n { color:var(--muted); margin-left:4px }
  main { max-width:1100px; margin:0 auto; padding:16px }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; align-items:start }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden; display:flex; flex-direction:column }
  .thumb { aspect-ratio:16/9; background:var(--chip) center/cover no-repeat }
  .body { padding:12px 14px 14px; display:flex; flex-direction:column; gap:6px }
  .kind { font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--accent); font-weight:600 }
  .t { font-weight:600; color:var(--fg); text-decoration:none; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden }
  .t:hover { color:var(--accent) } .meta { color:var(--muted); font-size:12.5px }
  .why { font-size:13.5px } .why b { font-weight:600 } .sum { font-size:13.5px; color:var(--muted) }
  .tags { display:flex; gap:5px; flex-wrap:wrap; margin-top:2px }
  #map { height:calc(100vh - 150px); border-radius:14px; border:1px solid var(--line) }
  .empty { color:var(--muted); text-align:center; padding:60px 0 }
  @media (max-width:600px) { h1 { display:none } .grid { grid-template-columns:1fr } }
</style></head><body>
<header>
  <div class="top"><h1>Saved</h1><input type="search" id="q" placeholder="Search everything you saved…" autocomplete="off">
    <span class="count" id="count"></span>
    <div class="seg"><button id="vList" class="on">List</button><button id="vMap">Map</button></div></div>
  <div class="chips" id="kinds"></div><div class="chips" id="tags"></div>
</header>
<main><div class="grid" id="grid"></div><div id="map" hidden></div><p class="empty" id="empty" hidden>Nothing matches.</p></main>
<script>
const items = __DATA__;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { q: '', kind: null, tag: null, view: 'list' };
const tagsOf = it => (it.tags || '').split(',').filter(Boolean);
const hay = it => [it.title, it.name, it.summary, it.why, it.note, it.tags, it.description, it.city, it.area, it.address, it.domain, it.author, it.cuisine].join(' ').toLowerCase();
items.forEach(it => it._h = hay(it));

function counts(key) {
  const m = new Map();
  items.forEach(it => (key === 'tag' ? tagsOf(it) : [it.kind || 'other']).forEach(v => m.set(v, (m.get(v) || 0) + 1)));
  return [...m].sort((a, b) => b[1] - a[1]);
}
function chips(el, key, list) {
  el.innerHTML = list.map(([v, n]) => `<button class="chip${state[key] === v ? ' on' : ''}" data-v="${esc(v)}">${esc(v)}<span class="n">${n}</span></button>`).join('');
  el.onclick = e => { const b = e.target.closest('.chip'); if (!b) return; state[key] = state[key] === b.dataset.v ? null : b.dataset.v; render(); };
}
function filtered() {
  const words = state.q.toLowerCase().split(/\\s+/).filter(Boolean);
  return items.filter(it => (!state.kind || (it.kind || 'other') === state.kind) && (!state.tag || tagsOf(it).includes(state.tag)) && words.every(w => it._h.includes(w)));
}
function card(it) {
  const place = [...new Set([it.area, it.city].filter(Boolean))].join(', ');
  const meta = [it.kind === 'place' ? it.cuisine : (it.site || it.domain), it.author, place, it.rating && `${it.rating}★`, it.starts_at && it.starts_at.slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · ');
  const href = it.maps_url || it.url;
  const text = it.why ? `<div class="why"><b>Why:</b> ${esc(it.why)}</div>` : '';
  const sum = it.summary || it.description || it.note;
  return `<article class="card">${it.image ? `<div class="thumb" style="background-image:url('${esc(it.image)}')"></div>` : ''}
    <div class="body"><div class="kind">${esc(it.kind || 'link')}${it.status && it.status !== 'saved' ? ' · ' + esc(it.status) : ''}</div>
    <a class="t" href="${esc(href)}" target="_blank" rel="noopener">${esc(it.title || it.name || it.url)}</a>
    <div class="meta">${esc(meta)}</div>${text}${sum ? `<div class="sum">${esc(sum.length > 220 ? sum.slice(0, 217) + '…' : sum)}</div>` : ''}
    <div class="tags">${tagsOf(it).map(t => `<button class="chip" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div></div></article>`;
}
let map, layer;
function drawMap(list) {
  const pts = list.filter(it => it.lat != null && it.lon != null);
  if (!map) { map = L.map('map'); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map); layer = L.featureGroup().addTo(map); }
  layer.clearLayers();
  pts.forEach(it => L.circleMarker([it.lat, it.lon], { radius: 8, color: '#c2410c', weight: 2, fillOpacity: .6 })
    .bindPopup(`<b>${esc(it.title || it.name)}</b><br>${esc([it.area, it.city, it.rating && it.rating + '★'].filter(Boolean).join(' · '))}${it.why ? '<br>' + esc(it.why) : ''}<br><a href="${esc(it.maps_url || it.url)}" target="_blank" rel="noopener">open</a>`).addTo(layer));
  setTimeout(() => { map.invalidateSize(); if (pts.length) map.fitBounds(layer.getBounds().pad(0.15), { maxZoom: 15 }); else map.setView([-33.87, 151.21], 11); }, 0);
}
function render() {
  chips(document.getElementById('kinds'), 'kind', counts('kind'));
  chips(document.getElementById('tags'), 'tag', counts('tag').slice(0, 24));
  const list = filtered();
  document.getElementById('count').textContent = `${list.length} of ${items.length}`;
  const isMap = state.view === 'map';
  document.getElementById('grid').hidden = isMap; document.getElementById('map').hidden = !isMap;
  document.getElementById('empty').hidden = list.length > 0;
  document.getElementById('vList').classList.toggle('on', !isMap); document.getElementById('vMap').classList.toggle('on', isMap);
  if (isMap) drawMap(list); else document.getElementById('grid').innerHTML = list.map(card).join('');
}
document.getElementById('q').oninput = e => { state.q = e.target.value; render(); };
document.getElementById('vList').onclick = () => { state.view = 'list'; render(); };
document.getElementById('vMap').onclick = () => { state.view = 'map'; render(); };
document.getElementById('grid').onclick = e => { const b = e.target.closest('[data-tag]'); if (b) { state.tag = b.dataset.tag; render(); } };
render();
</script></body></html>
"""


PLAN_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  :root { --paper:#f4efe6; --ink:#22201c; --muted:#767066; --line:#ddd5c7; --accent:#b4532a; --accent-soft:#ecd9c9; --chip:#e9e2d5; }
  * { box-sizing:border-box; margin:0 }
  html, body { background:var(--paper); color:var(--ink); font:400 15px/1.45 Inter,-apple-system,sans-serif }
  .card { width:1080px; min-height:1350px; padding:64px 64px 56px; display:flex; flex-direction:column; gap:28px }
  .eyebrow { display:flex; justify-content:space-between; align-items:center; font:500 22px/1 Inter; color:var(--muted); letter-spacing:.02em }
  .wx { display:flex; gap:10px; align-items:center; background:var(--chip); padding:10px 16px; border-radius:999px; color:var(--ink); font-size:20px }
  h1 { font:600 68px/1.02 Fraunces,Georgia,serif; letter-spacing:-.015em }
  .lede { font-size:26px; line-height:1.4; color:#3d3a34; max-width:900px }
  .tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:14px }
  .tile { background:#fbf8f2; border:1px solid var(--line); border-radius:18px; padding:16px 18px; display:flex; flex-direction:column; gap:4px }
  .tile .ic { font-size:28px; line-height:1 } .tile .v { font:600 26px/1.15 Fraunces,Georgia,serif } .tile .k { font-size:16px; color:var(--muted) }
  .map { height:430px; border-radius:22px; overflow:hidden; border:1px solid var(--line) }
  .stops { display:flex; flex-direction:column }
  .stop { display:grid; grid-template-columns:96px 48px 1fr; column-gap:18px; align-items:start }
  .time { font:600 24px/1.2 Inter; padding-top:6px; text-align:right; color:var(--ink) }
  .rail { display:flex; flex-direction:column; align-items:center; height:100% }
  .num { width:44px; height:44px; border-radius:50%; background:var(--accent); color:#fff; font:600 22px/44px Inter; text-align:center; flex:none }
  .line { flex:1; width:2px; background:repeating-linear-gradient(var(--accent) 0 6px, transparent 6px 12px); min-height:24px; opacity:.55 }
  .body { padding-bottom:14px }
  .name { font:600 30px/1.2 Fraunces,Georgia,serif } .name .ico { margin-right:10px }
  .what { font-size:21px; color:var(--muted); margin-top:4px }
  .why { font-size:22px; margin-top:8px; line-height:1.4 }
  .tip { font-size:19px; margin-top:8px; color:var(--accent); }
  .fact { font-size:18px; margin-top:10px; padding:10px 14px; background:var(--accent-soft); border-radius:12px; color:#4a3426; display:inline-block }
  .ico { font-size:28px }
  .move { grid-column:3; font-size:18px; color:var(--muted); padding:2px 0 16px; display:flex; gap:8px; align-items:center }
  .notes { margin-top:auto; border-top:1px solid var(--line); padding-top:22px; display:flex; flex-direction:column; gap:8px; font-size:20px; color:#3d3a34 }
  .notes b { font-weight:600 }
  .leaflet-control-zoom, .leaflet-control-attribution { display:none }
  .map .leaflet-tile-pane { filter:saturate(.55) sepia(.18) brightness(1.03) }
  /* Phone: the same plan as a light, scrollable page with a live map. The PNG is rendered at 1080 wide. */
  @media (max-width:760px) {
    .card { width:auto; min-height:0; padding:22px 18px 28px; gap:18px }
    .eyebrow { font-size:14px; flex-wrap:wrap; gap:8px } .wx { font-size:13px; padding:6px 10px }
    h1 { font-size:36px } .lede { font-size:16px }
    .tiles { grid-template-columns:repeat(2,1fr); gap:10px } .tile { padding:12px 14px; border-radius:14px }
    .tile .ic { font-size:20px } .tile .v { font-size:19px } .tile .k { font-size:13px }
    .map { height:300px; border-radius:16px } .leaflet-control-zoom { display:block }
    .stop { grid-template-columns:52px 32px 1fr; column-gap:10px }
    .time { font-size:15px; padding-top:4px } .num { width:30px; height:30px; font-size:15px; line-height:30px }
    .name { font-size:20px } .ico { font-size:20px } .name .ico { margin-right:6px } .what { font-size:14px } .why { font-size:15px }
    .tip { font-size:14px } .fact { font-size:13.5px; padding:8px 10px } .move { font-size:13px; padding-bottom:12px }
    .notes { font-size:15px; padding-top:16px } .pin { width:32px!important; height:32px!important; font-size:15px; line-height:26px }
    .stop { cursor:pointer }
  }
  .pin { background:var(--accent); color:#fff; border:3px solid #fff; border-radius:50%; width:42px!important; height:42px!important; font:600 20px/36px Inter; text-align:center; box-shadow:0 2px 6px rgba(0,0,0,.25) }
  .credit { font-size:13px; color:var(--muted); text-align:right }
</style></head><body>
<div class="card">
  <div class="eyebrow"><span id="date"></span><span class="wx" id="wx" hidden></span></div>
  <div><h1 id="title"></h1><p class="lede" id="lede" style="margin-top:16px"></p></div>
  <div class="tiles" id="tiles"></div>
  <div class="map" id="map"></div>
  <div class="stops" id="stops"></div>
  <div class="notes" id="notes"></div>
  <div class="credit">Map © OpenStreetMap contributors</div>
</div>
<script>
const plan = __DATA__;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const $ = id => document.getElementById(id);
$('date').textContent = plan.date_label || plan.date || '';
$('title').textContent = plan.title || 'Today';
$('lede').textContent = plan.summary || '';
if (plan.weather) { $('wx').hidden = false; $('wx').textContent = plan.weather; }
$('stops').innerHTML = plan.stops.map((s, i) => {
  const last = i === plan.stops.length - 1;
  return `<div class="stop"><div class="time">${esc(s.time)}</div>
    <div class="rail"><div class="num">${i + 1}</div>${last ? '' : '<div class="line"></div>'}</div>
    <div class="body"><div class="name">${s.icon ? `<span class="ico">${esc(s.icon)}</span>` : ''}${esc(s.name)}</div>
      ${s.what ? `<div class="what">${esc(s.what)}</div>` : ''}
      ${s.why ? `<div class="why">${esc(s.why)}</div>` : ''}
      ${s.tip ? `<div class="tip">${esc(s.tip)}</div>` : ''}
      ${s.fact ? `<div class="fact">${esc(s.fact)}</div>` : ''}</div></div>
    ${!last && s.move ? `<div class="stop"><div></div><div class="rail"><div class="line"></div></div><div class="move">${esc(s.move)}</div></div>` : ''}`;
}).join('');
$('tiles').innerHTML = (plan.info || []).slice(0, 4).map(t => `<div class="tile"><span class="ic">${esc(t.icon)}</span><span class="v">${esc(t.value)}</span><span class="k">${esc(t.label)}</span></div>`).join('');
$('tiles').hidden = !(plan.info || []).length;
$('notes').innerHTML = (plan.notes || []).map(n => `<div>${esc(n)}</div>`).join('');
$('notes').hidden = !(plan.notes || []).length;
const map = L.map('map', { zoomSnap: 0.25 });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
const pts = plan.stops.filter(s => s.lat != null).map(s => [s.lat, s.lon]);
if (pts.length > 1) L.polyline(pts, { color: '#b4532a', weight: 4, opacity: .8, dashArray: '2 10', lineCap: 'round' }).addTo(map);
plan.stops.forEach((s, i) => { if (s.lat != null) L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'pin', html: String(i + 1), iconSize: [42, 42] }) }).addTo(map); });
if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 16 });
[...document.querySelectorAll('#stops .num')].forEach((n, i) => {
  const st = plan.stops[i];
  if (st && st.lat != null) n.closest('.stop').onclick = () => { map.flyTo([st.lat, st.lon], 16); document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
});
</script></body></html>
"""


def walk_minutes(a, b):
    # Straight-line distance x1.3 for streets, at 4.8 km/h.
    return round(km_between(a, b) * 1.3 / 4.8 * 60)


def cmd_plan(con, a):
    """The agent curates (picks, order, times, why); this lays it out.
    FILE.json: {title, date, summary, notes: [..], info: [{icon, value, label}] (up to 4 tiles),
                stops: [{id | name+lat+lon, time, icon, what, why, tip, fact, move}]}
    Missing name/coordinates come from the library; `move` defaults to the walking time; weather is filled in."""
    plan = json.load(open(a.file, encoding='utf-8'))
    stops = []
    for st in plan.get('stops', []):
        if st.get('id'):
            r = get_row(con, st['id'])
            st = dict({'name': r['name'] or r['title'], 'lat': r['lat'], 'lon': r['lon']}, **st)
        stops.append(st)
    for here, nxt in zip(stops, stops[1:]):
        if not here.get('move') and here.get('lat') is not None and nxt.get('lat') is not None:
            mins = walk_minutes((here['lat'], here['lon']), (nxt['lat'], nxt['lon']))
            here['move'] = f'{mins} min walk' if mins <= 35 else f'{km_between((here["lat"], here["lon"]), (nxt["lat"], nxt["lon"])):.1f} km: bus, train or ride'
    plan['stops'] = stops
    day = plan.get('date') or dt.date.today().isoformat()
    try:
        d = dt.date.fromisoformat(day)
        plan.setdefault('date_label', d.strftime('%A %-d %B'))
    except ValueError:
        pass
    first = next((s for s in stops if s.get('lat') is not None), None)
    if first and not plan.get('weather'):
        try:
            w = get_json('https://api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode({
                'latitude': first['lat'], 'longitude': first['lon'], 'timezone': 'auto', 'start_date': day,
                'end_date': day, 'daily': 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'}))
            dd = {k: v[0] for k, v in w['daily'].items()}
            plan['weather'] = (f"{WEATHER_CODES.get(dd['weather_code'], '')} · {round(dd['temperature_2m_min'])}–"
                               f"{round(dd['temperature_2m_max'])}°C · {dd['precipitation_probability_max']}% rain")
        except (urllib.error.URLError, ValueError, OSError, KeyError):
            pass
    walked = sum(km_between((x['lat'], x['lon']), (y['lat'], y['lon'])) * 1.3 for x, y in zip(stops, stops[1:])
                 if x.get('lat') is not None and y.get('lat') is not None and walk_minutes((x['lat'], x['lon']), (y['lat'], y['lon'])) <= 35)
    info = plan.setdefault('info', [])
    if walked and len(info) < 4 and not any('walk' in (t.get('label', '') + t.get('value', '')).lower() for t in info):
        info.append({'icon': '🚶', 'value': f'{walked:.1f} km', 'label': 'walking between stops'})
    if first and len(info) < 4 and not any('sunset' in t.get('label', '').lower() for t in info):
        try:
            w = get_json('https://api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode({
                'latitude': first['lat'], 'longitude': first['lon'], 'timezone': 'auto', 'start_date': day,
                'end_date': day, 'daily': 'sunset'}))
            sunset = dt.datetime.fromisoformat(w['daily']['sunset'][0]).strftime('%-I:%M %p').lower()
            info.append({'icon': '🌅', 'value': sunset, 'label': 'sunset'})
        except (urllib.error.URLError, ValueError, OSError, KeyError):
            pass
    page = PLAN_HTML.replace('__TITLE__', html.escape(plan.get('title', 'Plan'))) \
                    .replace('__DATA__', json.dumps(plan, ensure_ascii=False).replace('</', '<\\/'))
    os.makedirs(os.path.join(DATA, 'plans'), exist_ok=True)
    slug = re.sub(r'[^a-z0-9]+', '-', plan.get('title', 'plan').lower()).strip('-')[:50]
    path = os.path.join(DATA, 'plans', f'{day}-{slug}.html')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(page)
    png = os.path.splitext(path)[0] + '.png'
    if os.path.exists(CHROME):
        # Tall window, then the card is cropped by Chrome to the window: 1080 wide, height fits the content.
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1080,1920',
                        '--force-device-scale-factor=1', '--virtual-time-budget=9000', f'--screenshot={png}',
                        'file://' + path], capture_output=True, timeout=120)
    if a.open:
        subprocess.run(['open', png if os.path.exists(png) else path], check=False)
    out({'html': path, 'png': png if os.path.exists(png) else None, 'weather': plan.get('weather'),
         'stops': [{k: s.get(k) for k in ('time', 'name', 'move')} for s in stops]})


def cmd_map(con, a):
    rows = place_rows(con, a, a.ids or None)
    if a.hermes:
        rows += [h for h in hermes_places() if not a.city or (h['city'] or '').lower() == a.city.lower()]
    pts = [r for r in rows if r.get('lat') is not None and r.get('lon') is not None]
    missing = [r.get('id') for r in rows if r.get('lat') is None]
    keep = ['source', 'id', 'title', 'name', 'area', 'city', 'cuisine', 'price', 'why', 'summary', 'note', 'url', 'lat', 'lon']
    data = [dict({k: r.get(k) for k in keep}, url=r.get('maps_url') or r.get('url'),
                 meta=' · '.join(filter(None, [r.get('rating') and f"{r['rating']}★", r.get('hours')]))) for r in pts]
    title = a.title or ('Places' + (f' in {a.city}' if a.city else ''))
    page = (MAP_HTML.replace('__TITLE__', html.escape(title))
            .replace('__SUB__', html.escape(f'{len(data)} places · {dt.date.today().isoformat()}'))
            .replace('__DATA__', json.dumps(data, ensure_ascii=False).replace('</', '<\\/')))
    path = a.out or os.path.join(DATA, 'maps', f"{dt.date.today().isoformat()}-{re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')}.html")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(page)
    res = {'map': path, 'places': len(data), 'without_coordinates': missing}
    if a.png:
        res['png'] = render_png(path)
    if a.open:
        subprocess.run(['open', res.get('png') or path], check=False)
    out(res)


CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def render_png(html_path, width=1080, height=1350):
    """Phone-portrait picture of a page (map on top, the list under it), for sharing."""
    png = os.path.splitext(html_path)[0] + '.png'
    if not os.path.exists(CHROME):
        return None
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', f'--window-size={width},{height}',
                    '--force-device-scale-factor=1', '--virtual-time-budget=8000', f'--screenshot={png}',
                    'file://' + os.path.abspath(html_path) + '#card'], capture_output=True, timeout=90)
    return png if os.path.exists(png) else None


def cmd_import_hermes(con, a):
    added, skipped = [], []
    for h in hermes_places():
        url = h['url'] or ('https://www.google.com/maps/search/?api=1&query='
                           + urllib.parse.quote_plus(f"{h['name']} {h['city'] or ''}".strip()))
        nurl = normalize_url(url)
        if con.execute('SELECT 1 FROM links WHERE url = ? OR maps_url = ? OR (kind = ? AND lower(name) = lower(?))',
                       (nurl, url, 'place', h['name'])).fetchone():
            skipped.append(h['name'])
            continue
        tags = merge_tags(h['tags'], h.get('place_kind'))
        con.execute(
            """INSERT INTO links (url, domain, kind, status, title, name, address, area, city, lat, lon, cuisine, price,
                                  note, tags, maps_url, source, added_at, pinned)
               VALUES (?, ?, 'place', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hermes', ?, ?)""",
            (nurl, domain_of(nurl), 'been' if h['status'] == 'been' else 'saved', h['name'], h['name'], h['address'],
             h['area'], h['city'], h['lat'], h['lon'], h['cuisine'], h['price'], h['note'], tags,
             url if 'google.' in url else None, now(), 'name,lat,lon,city,address'))
        added.append(h['name'])
    con.commit()
    out({'imported': added, 'already_in_library': skipped, 'note': '~/.hermes/places.db was only read'})


WEATHER_CODES = {0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog',
                 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain',
                 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers',
                 82: 'heavy showers', 95: 'thunderstorm', 96: 'thunderstorm, hail', 99: 'thunderstorm, hail'}


def cmd_weather(con, a):
    if a.place:
        r = get_row(con, a.place)
        if r['lat'] is None:
            die(f'link {a.place} has no coordinates')
        lat, lon = r['lat'], r['lon']
    elif a.at:
        lat, lon = (float(x) for x in a.at.split(','))
    else:
        die('give --at LAT,LON or --place ID')
    day = a.date or dt.date.today().isoformat()
    q = urllib.parse.urlencode({
        'latitude': lat, 'longitude': lon, 'timezone': 'auto', 'start_date': day, 'end_date': day,
        'daily': 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,'
                 'precipitation_sum,wind_speed_10m_max,uv_index_max,sunrise,sunset',
        'hourly': 'temperature_2m,precipitation_probability,weather_code'})
    try:
        w = get_json('https://api.open-meteo.com/v1/forecast?' + q)
    except (urllib.error.URLError, ValueError, OSError) as e:
        die(f'weather unavailable: {e}')
    d = {k: v[0] for k, v in w['daily'].items()}
    hours = w.get('hourly', {})
    by_hour = [{'time': t[11:16], 'temp': tt, 'rain_pct': pp, 'sky': WEATHER_CODES.get(c, c)}
               for t, tt, pp, c in zip(hours.get('time', []), hours.get('temperature_2m', []),
                                       hours.get('precipitation_probability', []), hours.get('weather_code', []))
               if 8 <= int(t[11:13]) <= 21 and int(t[11:13]) % 2 == 0]
    out({'date': day, 'sky': WEATHER_CODES.get(d['weather_code'], d['weather_code']),
         'temp_min': d['temperature_2m_min'], 'temp_max': d['temperature_2m_max'],
         'rain_chance_pct': d['precipitation_probability_max'], 'rain_mm': d['precipitation_sum'],
         'wind_max_kmh': d['wind_speed_10m_max'], 'uv_max': d['uv_index_max'],
         'sunrise': d['sunrise'][11:], 'sunset': d['sunset'][11:], 'daytime': by_hour})


def cmd_page(con, a):
    rows = con.execute("SELECT * FROM links WHERE status != 'archived' ORDER BY id DESC").fetchall()
    keep = ['id', 'kind', 'status', 'title', 'name', 'url', 'maps_url', 'domain', 'site', 'author', 'published',
            'image', 'summary', 'why', 'note', 'tags', 'description', 'area', 'city', 'address', 'lat', 'lon',
            'rating', 'hours', 'price', 'cuisine', 'website', 'starts_at', 'venue', 'added_at']
    data = []
    for r in rows:
        d = {k: r[k] for k in keep if r[k] not in (None, '')}
        if d.get('description') and (d.get('summary') or len(d['description']) > 400):
            d['description'] = d['description'][:400]
        data.append(d)
    page = LIBRARY_HTML.replace('__DATA__', json.dumps(data, ensure_ascii=False).replace('</', '<\\/')) \
                       .replace('__DATE__', dt.date.today().isoformat())
    path = a.out or os.path.join(DATA, 'library.html')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(page)
    if a.open:
        subprocess.run(['open', path], check=False)
    out({'page': path, 'links': len(data)})


# ---------- Notion mirror (one-way: the local library is the source of truth) ----------

NOTION_CONF = os.path.join(DATA, 'notion.json')
NOTION_VERSION = '2022-06-28'
NOTION_SCHEMA = {
    'Name': {'title': {}}, 'URL': {'url': {}}, 'Kind': {'select': {}}, 'Status': {'select': {}},
    'Tags': {'multi_select': {}}, 'Why': {'rich_text': {}}, 'Summary': {'rich_text': {}}, 'Note': {'rich_text': {}},
    'Author': {'rich_text': {}}, 'City': {'select': {}}, 'Area': {'rich_text': {}}, 'Address': {'rich_text': {}},
    'Rating': {'rich_text': {}}, 'Hours': {'rich_text': {}}, 'Google Maps': {'url': {}}, 'Website': {'url': {}},
    'Lat': {'number': {}}, 'Lon': {'number': {}}, 'When': {'rich_text': {}}, 'Added': {'date': {}},
    'Local ID': {'number': {}},
}


@__import__('functools').lru_cache(maxsize=None)
def notion_key():
    """From the environment, else hq-auth (personal's grant for the notion service, ~/.config/hq/auth.json)."""
    if os.environ.get('NOTION_API_KEY'):
        return os.environ['NOTION_API_KEY']
    hq = os.path.dirname(os.path.dirname(AGENT_DIR))
    r = subprocess.run([os.path.join(hq, 'bin', 'hq-auth'), 'get', '--for', 'personal', 'notion', 'NOTION_API_KEY'],
                       capture_output=True, text=True)
    return r.stdout.strip() or None


def notion(method, path, body=None):
    import time
    for attempt in range(4):
        req = urllib.request.Request('https://api.notion.com/v1/' + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': 'Bearer ' + notion_key(), 'Notion-Version': NOTION_VERSION,
                                              'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                time.sleep(0.35)  # Notion allows ~3 requests/s
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and attempt < 3:
                time.sleep(float(e.headers.get('Retry-After') or 2 ** attempt))
                continue
            raise RuntimeError(f'Notion {e.code}: {e.read().decode(errors="replace")[:300]}')


def rt(text):
    text = (text or '')[:1990]
    return [{'type': 'text', 'text': {'content': text}}] if text else []


def notion_props(r):
    tags = [{'name': t[:100]} for t in (r['tags'] or '').split(',') if t][:20]
    url = lambda u: u if u and re.match(r'^https?://', u) else (('https://' + u) if u else None)
    when = ' – '.join(filter(None, [r['starts_at'], r['ends_at']])) or r['published']
    added = (r['added_at'] or now())[:10]
    return {
        'Name': {'title': rt(r['title'] or r['name'] or r['url'])},
        'URL': {'url': r['url']}, 'Kind': {'select': {'name': r['kind']} if r['kind'] else None},
        'Status': {'select': {'name': r['status']}}, 'Tags': {'multi_select': tags},
        'Why': {'rich_text': rt(r['why'])}, 'Summary': {'rich_text': rt(r['summary'] or r['description'])},
        'Note': {'rich_text': rt(r['note'])}, 'Author': {'rich_text': rt(r['author'])},
        'City': {'select': {'name': r['city'][:100].replace(',', ' ')} if r['city'] else None},
        'Area': {'rich_text': rt(r['area'])}, 'Address': {'rich_text': rt(r['address'])},
        'Rating': {'rich_text': rt(r['rating'])}, 'Hours': {'rich_text': rt(r['hours'])},
        'Google Maps': {'url': r['maps_url']}, 'Website': {'url': url(r['website'])},
        'Lat': {'number': r['lat']}, 'Lon': {'number': r['lon']}, 'When': {'rich_text': rt(when)},
        'Added': {'date': {'start': added}}, 'Local ID': {'number': r['id']},
    }


def notion_db(parent=None):
    conf = json.load(open(NOTION_CONF)) if os.path.exists(NOTION_CONF) else {}
    if conf.get('database_id'):
        return conf['database_id']
    parent = parent or conf.get('parent')
    if not parent:
        return None
    db_ = notion('POST', 'databases', {'parent': {'type': 'page_id', 'page_id': parent}, 'is_inline': True,
                                       'title': rt('Links'), 'icon': {'type': 'emoji', 'emoji': '🔖'},
                                       'properties': NOTION_SCHEMA})
    conf.update(parent=parent, database_id=db_['id'], url=db_.get('url'))
    os.makedirs(DATA, exist_ok=True)
    json.dump(conf, open(NOTION_CONF, 'w'), indent=2)
    return db_['id']


def notion_sync(con, parent=None, everything=False):
    if not notion_key():
        return {'skipped': 'no NOTION_API_KEY'}
    dbid = notion_db(parent)
    if not dbid:
        return {'skipped': 'no Notion database yet: run `links notion --parent PAGE_ID` once'}
    where = '1=1' if everything else 'notion_synced_at IS NULL OR updated_at > notion_synced_at OR added_at > notion_synced_at'
    rows = con.execute(f'SELECT * FROM links WHERE {where} ORDER BY id').fetchall()
    done, failed = [], []
    for r in rows:
        body = {'properties': notion_props(r)}
        if r['image'] and re.match(r'^https?://', r['image']):
            body['cover'] = {'type': 'external', 'external': {'url': r['image'][:1900]}}
        try:
            if r['notion_id']:
                notion('PATCH', f"pages/{r['notion_id']}", dict(body, archived=r['status'] == 'archived'))
                nid = r['notion_id']
            else:
                nid = notion('POST', 'pages', dict(body, parent={'database_id': dbid}))['id']
        except RuntimeError as e:
            failed.append({'id': r['id'], 'error': str(e)[:200]})
            continue
        # Direct write: update() would bump updated_at and make the row look changed again.
        con.execute('UPDATE links SET notion_id = ?, notion_synced_at = ? WHERE id = ?', (nid, now(), r['id']))
        con.commit()
        done.append(r['id'])
    return {'synced': done, 'failed': failed}


def auto_sync(con):
    """After any write: mirror to Notion if it's set up. Never fails the command."""
    if not os.path.exists(NOTION_CONF) or os.environ.get('PERSONAL_NO_SYNC'):
        return
    try:
        res = notion_sync(con)
        if res.get('failed'):
            print(f"links: Notion sync failed for {len(res['failed'])} link(s); run `links notion` to retry", file=sys.stderr)
    except Exception as e:  # offline, token revoked…: the local save already happened
        print(f'links: Notion sync skipped ({e})', file=sys.stderr)


def cmd_notion(con, a):
    if a.parent:
        m = re.findall(r'[0-9a-f]{32}', a.parent.replace('-', '').lower())
        if not m:
            die('give the page URL or its 32-character ID')
        a.parent = m[-1]
    res = notion_sync(con, a.parent, a.all)
    if os.path.exists(NOTION_CONF):
        res['database'] = json.load(open(NOTION_CONF)).get('url')
    out(res)


def cmd_export(con, a):
    rows = con.execute("SELECT * FROM links WHERE status != 'archived' ORDER BY kind, id").fetchall()
    if a.format == 'json':
        out([full(r) for r in rows])
        return
    kind = None
    for r in rows:
        if r['kind'] != kind:
            kind = r['kind']
            print(f'\n## {kind or "unsorted"}\n')
        tags = f" `{r['tags']}`" if r['tags'] else ''
        print(f"- [{r['title'] or r['name'] or r['url']}]({r['url']}){tags}")
        for line in filter(None, [r['summary'], r['why'] and f"why: {r['why']}", r['note'] and f"note: {r['note']}"]):
            print(f'  - {line}')


def cmd_stats(con, a):
    q = lambda sql: [dict(r) for r in con.execute(sql)]
    out({
        'db': DB, 'inbox': INBOX,
        'total': con.execute('SELECT count(*) FROM links').fetchone()[0],
        'by_kind': q('SELECT kind, count(*) n FROM links GROUP BY kind ORDER BY n DESC'),
        'by_status': q('SELECT status, count(*) n FROM links GROUP BY status ORDER BY n DESC'),
        'not_annotated': con.execute('SELECT count(*) FROM links WHERE annotated_at IS NULL').fetchone()[0],
        'fetch_failed': q("SELECT id, url, fetch_error FROM links WHERE fetch_error IS NOT NULL"),
        'places_without_coordinates': con.execute("SELECT count(*) FROM links WHERE kind='place' AND lat IS NULL").fetchone()[0],
        'top_tags': q("""WITH RECURSIVE split(tag, rest) AS (
                           SELECT '', tags || ',' FROM links WHERE tags IS NOT NULL
                           UNION ALL SELECT substr(rest, 1, instr(rest, ',') - 1), substr(rest, instr(rest, ',') + 1)
                           FROM split WHERE rest != '')
                         SELECT tag, count(*) n FROM split WHERE tag != '' GROUP BY tag ORDER BY n DESC LIMIT 25"""),
    })


WRITES = {'add', 'inbox', 'enrich', 'annotate', 'text', 'transcribe', 'import-hermes'}


def main(argv=None):
    p = argparse.ArgumentParser(prog='links.py', description=__doc__.split('\n')[0])
    sub = p.add_subparsers(dest='cmd', required=True)

    s = sub.add_parser('add')
    s.add_argument('urls', nargs='+')
    s.add_argument('--note')
    s.add_argument('--tags')
    s.add_argument('--kind', choices=KINDS)
    s.add_argument('--source', default='cli')
    s.add_argument('--no-fetch', action='store_true')
    s.set_defaults(fn=cmd_add)

    s = sub.add_parser('inbox')
    s.add_argument('--file')
    s.add_argument('--no-fetch', action='store_true')
    s.set_defaults(fn=cmd_inbox)

    s = sub.add_parser('enrich')
    s.add_argument('ids', nargs='*', type=int)
    s.add_argument('--pending', action='store_true')
    s.add_argument('--force', action='store_true')
    s.set_defaults(fn=cmd_enrich)

    s = sub.add_parser('annotate')
    s.add_argument('id', type=int)
    for k in ('summary', 'why', 'note', 'title', 'tags'):
        s.add_argument(f'--{k}')
    s.add_argument('--kind')
    s.add_argument('--status')
    s.add_argument('--replace-tags', action='store_true')
    s.add_argument('--set', action='append', metavar='FIELD=VALUE')
    s.set_defaults(fn=cmd_annotate)

    s = sub.add_parser('text')
    s.add_argument('id', type=int)
    s.add_argument('--file')
    s.add_argument('--via', default='browser')
    s.set_defaults(fn=cmd_text)

    s = sub.add_parser('transcribe')
    s.add_argument('ids', nargs='+', type=int)
    s.add_argument('--max-min', type=float, default=20, help='skip videos longer than this (minutes)')
    s.set_defaults(fn=cmd_transcribe)

    s = sub.add_parser('show')
    s.add_argument('ids', nargs='+', type=int)
    s.add_argument('--content', action='store_true')
    s.set_defaults(fn=cmd_show)

    for name, fn in (('search', cmd_search), ('list', cmd_list)):
        s = sub.add_parser(name)
        if name == 'search':
            s.add_argument('query')
        s.add_argument('--kind')
        s.add_argument('--tag')
        s.add_argument('--status')
        s.add_argument('--city')
        s.add_argument('--limit', type=int, default=20 if name == 'search' else 50)
        if name == 'list':
            s.add_argument('--todo', action='store_true', help='not annotated yet')
            s.add_argument('--all', action='store_true', help='include archived')
        s.set_defaults(fn=fn)

    s = sub.add_parser('places')
    s.add_argument('--city')
    s.add_argument('--tag')
    s.add_argument('--near', help='LAT,LON')
    s.add_argument('--km', type=float, default=2.0)
    s.add_argument('--all', action='store_true', help='include done/archived')
    s.add_argument('--hermes', action='store_true', help='also read ~/.hermes/places.db (read-only)')
    s.set_defaults(fn=cmd_places)

    s = sub.add_parser('map')
    s.add_argument('ids', nargs='*', type=int)
    s.add_argument('--city')
    s.add_argument('--tag')
    s.add_argument('--title')
    s.add_argument('--hermes', action='store_true')
    s.add_argument('--out')
    s.add_argument('--png', action='store_true', help='also render a phone-sized PNG of the map and list')
    s.add_argument('--open', action='store_true')
    s.set_defaults(fn=cmd_map)

    s = sub.add_parser('plan')
    s.add_argument('file')
    s.add_argument('--open', action='store_true')
    s.set_defaults(fn=cmd_plan)

    s = sub.add_parser('page')
    s.add_argument('--out')
    s.add_argument('--open', action='store_true')
    s.set_defaults(fn=cmd_page)

    s = sub.add_parser('weather')
    s.add_argument('--at', help='LAT,LON (use --at=-33.7,150.3 for negative latitudes)')
    s.add_argument('--place', type=int, help='a saved place ID')
    s.add_argument('--date')
    s.set_defaults(fn=cmd_weather)

    s = sub.add_parser('import-hermes')
    s.set_defaults(fn=cmd_import_hermes)

    s = sub.add_parser('notion')
    s.add_argument('--parent', help='Notion page (ID or URL) to create the Links database in, first time only')
    s.add_argument('--all', action='store_true', help='push every link, not just new or changed ones')
    s.set_defaults(fn=cmd_notion)

    s = sub.add_parser('export')
    s.add_argument('--format', choices=['md', 'json'], default='md')
    s.set_defaults(fn=cmd_export)

    s = sub.add_parser('stats')
    s.set_defaults(fn=cmd_stats)

    a = p.parse_args(argv)
    con = db()
    try:
        a.fn(con, a)
        if a.cmd in WRITES:
            auto_sync(con)
    finally:
        con.close()


if __name__ == '__main__':
    main()
