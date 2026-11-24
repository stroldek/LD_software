from html.parser import HTMLParser
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'public' / 'index.html').read_text(encoding='utf-8')
JS = (ROOT / 'public' / 'app.js').read_text(encoding='utf-8')

class Structure(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids = []; self.pages = set(); self.nav = set(); self.in_creds = 0; self.contact_inside_creds = False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get('id'): self.ids.append(a['id'])
        if a.get('data-page'): self.pages.add(a['data-page'])
        if a.get('data-nav'): self.nav.add(a['data-nav'])
        if tag == 'form' and a.get('id') == 'credsForm': self.in_creds += 1
        if a.get('id') == 'contactAccount' and self.in_creds: self.contact_inside_creds = True
    def handle_endtag(self, tag):
        if tag == 'form' and self.in_creds: self.in_creds -= 1

p = Structure(); p.feed(HTML)
duplicates = sorted({i for i in p.ids if p.ids.count(i) > 1})
assert not duplicates, f'Duplicate IDs: {duplicates}'
assert {'overview','account','monitor','journal','leads'} <= p.pages
assert {'overview','account','monitor','journal','leads'} <= p.nav
assert not p.contact_inside_creds, 'Plan notification contact must remain visible even if app credentials are configured in Cloudflare'
assert 'ПЕРВАЯ ПРОВЕРКА' not in HTML
assert 'data:image/png;base64,' in HTML, 'Logo must be embedded as a PNG with alpha'
app_refs = set(re.findall(r"\$\('([^']+)'\)", JS))
missing = sorted(app_refs - set(p.ids))
assert not missing, f'JS selectors missing from HTML: {missing}'
print('PASS: UI structure, page navigation, selectors, contact placement, and logo reference')
