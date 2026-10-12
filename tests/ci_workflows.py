"""D1021: resolve CI contracts by job identity, independent of workflow layout.

REQ-W2-LAND-CI -> RISK-CI-SPLIT-OMISSION: missing/ambiguous jobs fail closed.
YAML parsing uses PyYAML; shell commands are inspected, never executed.
"""
from pathlib import Path
import re
import shlex


# This is the existing validation contract's job set, not a file allowlist.
# Looking each id up separately also rejects disappeared or duplicated jobs.
VALIDATION_JOBS = (
    'measurements', 'volume-rendering', 'volume-mpr', 'volume-slab', 'volume-path',
    'volume-batch', 'volume-sync-preferences', 'volume-marks', 'volume-mip-voi',
    'volume-mip-job', 'volume-mip-batch', 'volume-mip-output', 'volume-mip-orient',
    's7-u5-session-contracts', 'context-loss', 'hanging-protocols', 'cell-merge',
    'study-arrivals', 'u2b-regressions', 'runtime', 'asr-engine', 'dictation-capture',
)


class WorkflowCatalog:
    def __init__(self, root):
        import yaml

        class UniqueLoader(yaml.SafeLoader):
            pass

        def mapping(loader, node, deep=False):
            result = {}
            for key_node, value_node in node.value:
                key = loader.construct_object(key_node, deep=deep)
                if key in result:
                    raise ValueError(f'duplicate YAML key {key!r} at {key_node.start_mark}')
                result[key] = loader.construct_object(value_node, deep=deep)
            return result

        UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
        self.documents = {}
        self.owners = {}
        for path in sorted((Path(root) / '.github/workflows').glob('*.yml')):
            name = path.relative_to(root).as_posix()
            doc = yaml.load(path.read_text(encoding='utf-8'), Loader=UniqueLoader)
            self.documents[name] = doc
            for job_id, job in doc['jobs'].items():
                self.owners.setdefault(job_id, []).append((name, job))
        if not self.documents:
            raise ValueError('no CI workflows found')

    def owner(self, job_id):
        matches = self.owners.get(job_id, [])
        if len(matches) != 1:
            raise ValueError(f'job {job_id!r}: expected exactly one workflow, found {len(matches)}: '
                             + ', '.join(name for name, _ in matches))
        return matches[0]

    def job(self, job_id):
        return self.owner(job_id)[1]

    def validation(self):
        return {'jobs': {name: self.job(name) for name in VALIDATION_JOBS}}

    def combined(self, automatic_only=False):
        # Unrelated restore workflows legitimately reuse produce/consume job ids.
        # Keep those qualified; every contract that names a job uses owner().
        return {'jobs': {
            job_id if len(self.owners[job_id]) == 1 else name + ':' + job_id: job
            for name, doc in self.documents.items()
            if not automatic_only or self.automatic(doc)
            for job_id, job in doc['jobs'].items()}}

    @staticmethod
    def automatic(doc):
        events = doc.get('on', doc.get(True)) or {}
        return any(event in events for event in ('push', 'pull_request'))

    def text(self, automatic_only=False):
        return '\n'.join(self.job_text(job) for job in self.combined(automatic_only)['jobs'].values())

    @staticmethod
    def job_text(job):
        return '\n'.join(str(step.get('run', '')) + '\n' + str(step.get('with', {}).get('path', ''))
                         for step in job.get('steps', []))

    def profile_bindings(self):
        bindings = {}
        for workflow, doc in self.documents.items():
            triggers = doc.get('on', doc.get(True)) or {}
            inputs = ((triggers.get('workflow_dispatch') or {}).get('inputs') or {})
            for job_id, job in doc['jobs'].items():
                for index, step in enumerate(job.get('steps', [])):
                    run = step.get('run', '')
                    env = {**(doc.get('env') or {}), **(job.get('env') or {}), **(step.get('env') or {})}
                    # Protect GitHub expressions as a single shell token before shlex.
                    run = re.sub(r'\$\{\{[^}]+\}\}', lambda m: shlex.quote(m[0]), run)
                    for line in run.replace('\\\n', ' ').splitlines():
                        if 'tests/measurement_ci.py' not in line:
                            continue
                        words = shlex.split(line, comments=True)
                        positions = [i for i, word in enumerate(words) if word == 'tests/measurement_ci.py'
                                     and (not i or words[i - 1] != '--file')]
                        if not positions:
                            continue
                        if len(positions) != 1:
                            raise ValueError(f'{workflow}:{job_id}: ambiguous profile command')
                        pos = positions[0]
                        args = words[pos + 1:]
                        values = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg == '--profile']
                        values += [arg.split('=', 1)[1] for arg in args if arg.startswith('--profile=')]
                        if len(values) != 1:
                            raise ValueError(f'{workflow}:{job_id}: unresolved profile invocation')
                        value = values[0]
                        variable = re.fullmatch(r'\$\{?(\w+)\}?', value)
                        if variable:
                            value = str(env.get(variable[1], value))
                        matrix = re.fullmatch(r'\$\{\{\s*matrix\.(\w+)\s*\}\}', value)
                        dispatch = re.fullmatch(r'\$\{\{\s*inputs\.(\w+)\s*\}\}', value)
                        if matrix:
                            profiles = job['strategy']['matrix'][matrix[1]]
                        elif dispatch:
                            profiles = inputs[dispatch[1]]['options']
                        elif '$' in value:
                            raise ValueError(f'{workflow}:{job_id}: unresolved profile {value}')
                        else:
                            profiles = [value]
                        for profile in profiles:
                            bindings.setdefault(profile, []).append({
                                'workflow': workflow, 'job': job_id, 'step': index,
                                'dispatch': bool(dispatch)})
        return bindings

    def profile_report(self, profiles):
        bindings = self.profile_bindings()
        report = {}
        for profile in profiles:
            matches = bindings.get(profile, [])
            # Some standing profiles also remain explicitly available by dispatch.
            primary = [item for item in matches if not item['dispatch']] or matches
            if len(primary) != 1:
                raise ValueError(f'profile {profile!r}: expected exactly one owning job, found {len(primary)}')
            owner = primary[0]
            self.owner(owner['job'])
            report[profile] = {**owner, 'invocations': matches}
        return report
