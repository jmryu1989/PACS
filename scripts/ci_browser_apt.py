"""Exclude unused Google Chrome APT sources on disposable GitHub-hosted runners.

Playwright downloads its pinned Chromium separately. Its OS dependency installer
runs apt update, which otherwise also queries the runner's unrelated Chrome repo.
APT signature/hash verification and all Ubuntu package sources remain enabled.
"""
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


def chrome_url(value):
    url=urlsplit(value)
    return url.scheme in ('http','https') and url.hostname=='dl.google.com' and bool(re.match(r'^/linux/chrome(?:-stable)?/deb/?$',url.path))


def without_chrome(text,suffix):
    if suffix=='.list':
        return ''.join('# Disabled for pinned Playwright CI: '+line if
            re.match(r'^\s*deb(?:-src)?\s',line) and any(chrome_url(token) for token in line.split()) else line
            for line in text.splitlines(keepends=True))
    if suffix!='.sources':raise ValueError('Unsupported APT source format')
    def stanza(block):
        match=re.search(r'^URIs:[ \t]*(.*(?:\n[ \t]+[^\n]*)*)',block,re.M)
        if not match:return block
        urls=match.group(1).split()
        if not any(chrome_url(url) for url in urls):return block
        kept=[url for url in urls if not chrome_url(url)]
        if kept:return block[:match.start()]+'URIs: '+' '.join(kept)+block[match.end():]
        if re.search(r'^Enabled:',block,re.M):return re.sub(r'^Enabled:.*$', 'Enabled: no',block,flags=re.M)
        return block.rstrip('\n')+'\nEnabled: no\n'
    return '\n\n'.join(stanza(block) for block in text.split('\n\n'))


def main():
    if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or os.geteuid()!=0:
        raise RuntimeError('Only a root process on a disposable GitHub-hosted runner may prepare browser APT sources')
    for path in sorted(Path('/etc/apt/sources.list.d').iterdir()):
        if path.suffix not in ('.list','.sources'):continue
        if path.is_symlink():raise RuntimeError('Unexpected linked APT source')
        if not path.is_file():continue
        old=path.read_text(encoding='utf-8');new=without_chrome(old,path.suffix)
        if old!=new:
            path.write_text(new,encoding='utf-8')
            print('Excluded unused Chrome APT source in '+path.name,flush=True)


if __name__=='__main__':main()
