"""Send bounded operational events to one private GitHub repository, never raw logs."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request, build_opener, ProxyHandler

from ops_monitor import NoRedirect, read_json

MARKER = '<!-- kin-ops-monitor:v1 -->'
CODES = {'host_unhealthy', 'collector_unavailable', 'api_unavailable',
         'identity_unavailable', 'worklist_unavailable', 'notification_drill'}


class GitHub:
    def __init__(self, token, repo):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
            raise ValueError('Invalid repository')
        self.token, self.base = token, 'https://api.github.com/repos/' + repo

    def call(self, method, path='', data=None):
        req = Request(self.base + path, method=method,
                      data=None if data is None else json.dumps(data).encode(),
                      headers={'Authorization': 'Bearer ' + self.token,
                               'Accept': 'application/vnd.github+json',
                               'Content-Type': 'application/json',
                               'X-GitHub-Api-Version': '2022-11-28'})
        with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=20) as response:
            return json.load(response)


def notify(api, report, run_url, drill=False):
    repo = api.call('GET')
    if repo.get('private') is not True:
        raise ValueError('Operational notifications require a private repository')
    owner = repo['owner']['login']
    if not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/\d+', run_url):
        raise ValueError('Invalid run link')
    if (type(report.get('ok')) is not bool or type(report.get('checked_at')) is not int
            or not isinstance(report.get('faults'), list)
            or not set(report['faults']) <= CODES
            or report['ok'] != (len(report['faults']) == 0)):
        raise ValueError('Invalid notification report')
    marker = MARKER + (' drill' if drill else ' live')
    title = '[KIN 장애 훈련]' if drill else '[KIN 운영 장애]'
    issues = []
    for page in range(1, 11):
        batch = api.call('GET', f'/issues?state=open&per_page=100&page={page}')
        issues.extend(row for row in batch if row.get('user', {}).get('login') == 'github-actions[bot]'
                      and row.get('body', '').startswith(marker + '\n') and not row.get('pull_request'))
        if len(batch) < 100:
            break
    else:
        raise ValueError('Issue pagination limit reached; refusing duplicate notification')
    if report['ok']:
        if report.get('maintenance'):
            return 'maintenance'  # A paused probe cannot prove recovery.
        for issue in issues:
            api.call('POST', f"/issues/{issue['number']}/comments",
                     {'body': '복구 확인. UTC epoch: ' + str(report['checked_at']) + '\n' + run_url})
            api.call('PATCH', f"/issues/{issue['number']}", {'state': 'closed', 'state_reason': 'completed'})
        return 'recovered' if issues else 'healthy'
    if issues:
        for issue in issues:
            if owner not in [row['login'] for row in issue.get('assignees', [])]:
                updated = api.call('PATCH', f"/issues/{issue['number']}", {'assignees': [owner]})
                if owner not in [row['login'] for row in updated.get('assignees', [])]:
                    raise ValueError('Owner assignment was not confirmed')
        return 'ongoing'
    codes = ', '.join(sorted(set(report['faults'])))
    created = api.call('POST', '/issues', {'title': title + ' 감지', 'assignees': [owner],
                       'body': marker + '\n' + codes + '\nUTC epoch: ' + str(report['checked_at'])
                       + '\n' + run_url + '\n자동 감지이며 환자 정보/원본 로그는 포함하지 않습니다.'})
    if owner not in [row['login'] for row in created.get('assignees', [])]:
        raise ValueError('Owner assignment was not confirmed')
    return 'opened'


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--drill', action='store_true')
    args = parser.parse_args()
    try:
        result = notify(GitHub(os.environ['GH_TOKEN'], os.environ['GITHUB_REPOSITORY']),
                        read_json(args.report), os.environ['KIN_RUN_URL'], args.drill)
        print(json.dumps({'notification': result}))
    except Exception as error:
        print('notification failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
