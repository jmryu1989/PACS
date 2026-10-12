"""REQ-W2C-04 -> RISK-CI-EVIDENCE-OMISSION: collect by workflow and SHA.

List every upload declaration (including expression templates). Stage downloads
select all owners of each required artifact; workflow names are never pinned.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess

from ci_workflows import WorkflowCatalog

ROOT = Path(__file__).resolve().parents[1]
STAGE_ARTIFACTS = {
    '7': ('synthetic-runtime-record-runs', 'synthetic-workspace-dom-results'),
    '8': ('synthetic-runtime-record-runs', 'synthetic-workspace-dom-results',
          'synthetic-volume-rendering-results', 'synthetic-context-loss'),
}
CANDIDATE = 'candidate-${{ env.CANDIDATE_SHA }}'


def inventory(root):
    catalog = WorkflowCatalog(root)
    rows = []
    for workflow, doc in catalog.documents.items():
        for job_id, job in doc['jobs'].items():
            # Local restore jobs share ids; all other jobs must have one owner.
            owner = (catalog.owner(job_id)[0] if len(catalog.owners[job_id]) == 1
                     else workflow)
            for step in job.get('steps', []):
                if str(step.get('uses', '')).split('@')[0] == 'actions/upload-artifact':
                    rows.append({'workflow': owner, 'job': job_id,
                                 'artifact': step.get('with', {}).get('name', 'artifact')})
    return sorted(rows, key=lambda row: (row['workflow'], row['job'], row['artifact']))


def gh_json(*args):
    return json.loads(subprocess.check_output(['gh', *args], text=True, encoding='utf-8'))


def artifact_runs(query, workflow, artifact, owners):
    """Runs of `workflow` that uploaded `artifact`, found through the artifact name.

    A G3 run started by hand (`--ref main -f candidate_sha=X`) carries the dispatch
    ref's tip as head_sha, so only the artifact name ties it to X. Expired uploads
    still count, so an expired latest run is refused rather than skipped.
    """
    pages = query('api', '--paginate', '--slurp',
                  f'repos/{{owner}}/{{repo}}/actions/artifacts?name={artifact}&per_page=100')
    ids = sorted({item['workflow_run']['id'] for page in pages for item in page['artifacts']
                  if item['name'] == artifact})
    runs = []
    for run_id in ids:
        run = query('api', f'repos/{{owner}}/{{repo}}/actions/runs/{run_id}')
        uploader = run['path'].split('@')[0]
        if uploader not in owners:
            raise ValueError(f'{artifact}: uploaded by undeclared workflow {run["path"]} (run {run_id})')
        if uploader == workflow:
            runs.append(run)
    return runs


def download(root, sha, stage, out, query=gh_json, execute=subprocess.check_call):
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('full candidate SHA required')
    declarations = inventory(root)
    required = (*STAGE_ARTIFACTS[stage], CANDIDATE)
    selected = [row for row in declarations if row['artifact'] in required]
    missing = set(required) - {row['artifact'] for row in selected}
    if missing:
        raise ValueError(f'missing upload declarations: {sorted(missing)}')
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    (out / 'artifact-inventory.json').write_text(json.dumps(declarations, indent=2) + '\n', encoding='utf-8')
    manifest = {'sha': sha, 'stage': stage, 'runs': [], 'downloads': [], 'status': 'incomplete'}

    def save():
        (out / 'artifact-downloads.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

    save()
    try:
        for workflow in sorted({row['workflow'] for row in selected}):
            names = {row['artifact'] for row in selected if row['workflow'] == workflow}
            if CANDIDATE in names:
                # The candidate SHA is a dispatch input there, not necessarily the run's commit.
                lookup = 'artifact'
                owners = {row['workflow'] for row in selected if row['artifact'] == CANDIDATE}
                runs = artifact_runs(query, workflow, CANDIDATE.replace('${{ env.CANDIDATE_SHA }}', sha), owners)
            else:
                lookup = 'head_sha'
                name = Path(workflow).name
                pages = query('api', '--paginate', '--slurp',
                              f'repos/{{owner}}/{{repo}}/actions/workflows/{name}/runs?head_sha={sha}&per_page=100')
                runs = [run for page in pages for run in page['workflow_runs'] if run['head_sha'] == sha]
            if not runs:
                raise ValueError(f'{workflow}: no run for {sha}')
            run = max(runs, key=lambda item: (item['created_at'], item['id']))
            if run['path'].split('@')[0] != workflow:
                raise ValueError(f'{workflow}: unexpected run owner {run["path"]}')
            # Do not silently substitute an older passing run for a failed rerun.
            if run['status'] != 'completed' or run['conclusion'] != 'success':
                raise ValueError(f'{workflow}: latest run {run["id"]} is not completed/success')
            manifest['runs'].append({'workflow': workflow, 'id': run['id'], 'lookup': lookup,
                                     'sha': sha, 'run_head_sha': run['head_sha'], 'event': run.get('event'),
                                     'attempt': run['run_attempt'], 'conclusion': run['conclusion']})
            save()
            pages = query('api', '--paginate', '--slurp',
                          f'repos/{{owner}}/{{repo}}/actions/runs/{run["id"]}/artifacts?per_page=100')
            artifacts = [item for page in pages for item in page['artifacts']]
            for template in sorted(names):
                artifact = template.replace('${{ env.CANDIDATE_SHA }}', sha)
                matches = [item for item in artifacts if item['name'] == artifact and not item['expired']]
                if len(matches) != 1:
                    raise ValueError(f'{workflow}/{run["id"]}: expected one available {artifact}')
                category = ('candidate' if template == CANDIDATE else
                            'support' if artifact == 'synthetic-context-loss' else 'runs')
                destination = out / category / Path(workflow).stem / str(run['id']) / artifact
                execute(['gh', 'run', 'download', str(run['id']), '-n', artifact, '-D', str(destination)])
                manifest['downloads'].append({'workflow': workflow, 'run': run['id'],
                                              'artifact': artifact, 'artifact_id': matches[0]['id'],
                                              'destination': str(destination)})
                save()
        manifest['status'] = 'completed'
    finally:
        save()
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--list', action='store_true', help='all upload names/templates and every owning workflow/job')
    parser.add_argument('--sha')
    parser.add_argument('--stage', choices=STAGE_ARTIFACTS)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.list:
        print(json.dumps(inventory(args.root), indent=2))
    elif args.sha and args.stage and args.out:
        print(json.dumps(download(args.root, args.sha, args.stage, args.out), indent=2))
    else:
        parser.error('use --list or --sha SHA --stage 7|8 --out NEW_DIRECTORY')


if __name__ == '__main__':
    main()
