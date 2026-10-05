"""Read browser state on failure without changing the assertion or its timeout."""
from contextlib import contextmanager
import json


@contextmanager
def failure_details(page, label, expression):
    try:
        yield
    except Exception:
        try:
            details = page.evaluate(expression)
        except Exception as error:
            details = {"diagnostic_error": type(error).__name__}
        print(label + " " + json.dumps(details, ensure_ascii=False), flush=True)
        raise
