"""D1770 replacement of external-engine live mutants.

The retained SQL/transaction/failure negative controls now run at the actual
boundary in pg_ledger_restore_test.py and pg_ledger_api_test.cjs. Their assertions
observe a faulty result, restore the original implementation, then verify the
healthy result inside the same owned fixture. No nested live ticket or obsolete
external-engine image is launched by this compatibility entry point.
"""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))


def reporting_self_test():
    from mutants import self_test
    return self_test()


class EmrBLiveMutants:
    """An old performance caller gets an explicit obsolete-plan error."""
    def __init__(self,*args,**kwargs):
        raise RuntimeError('D1770: external-engine live-mutant plan removed; use the declared PG boundary controls')


if __name__=='__main__':
    if sys.argv[1:]==['--self-test']:
        sys.exit(reporting_self_test())
    raise SystemExit('D1770: use scripts/run-tests.py with the declared pg_ledger_restore_test.py boundary; this legacy plan is not a PASS')
