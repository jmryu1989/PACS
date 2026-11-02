# Trace fixture runner: a suite table in the shape of tests/measurement_ci.py. Read, never executed.
SUITES = ['fx_runner_test.py']
PROFILES = {
    'fx-profile': {
        'suite_timeout': 60,
        'suites': tuple((suite, None, 'ci-' + suite) for suite in SUITES),
    },
    # No workflow invokes this profile.
    'fx-idle': {
        'suites': (('fx_idle_live.py', 'FxIdleLive', 'ci-fx-idle'),),
    },
}
