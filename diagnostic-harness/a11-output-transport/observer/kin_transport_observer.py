"""Observation-only Playwright and unittest hooks of the never-merged A11 output transport diagnostic harness.

Installed only by this directory's sitecustomize when KIN_TRANSPORT_DIAG_DIR is set. Each wrapper calls the original with the
caller's own arguments and returns its result or raises its exception unchanged. The only argument it adds is the Chromium NetLog
switch pair on BrowserType.launch, in Default capture mode. Listeners and records only append JSON lines under
KIN_TRANSPORT_DIAG_DIR; a failure inside the observer is recorded, never raised into the test."""
import functools
import importlib.abc
import importlib.machinery
import json
import os
import sys
import threading
import time
from urllib.parse import parse_qsl, urlsplit, urlunsplit

TARGET = 'playwright.sync_api._generated'
CAPTURE_MODE = '--net-log-capture-mode=Default'
ORIGIN_SUFFIX = ':9443'
SOURCE_PREFIXES = ('/instances/', '/api/')
MARK = '_kin_transport_observer'
_lock = threading.RLock()
_state = {'installed': False, 'patched': False, 'seq': 0, 'launches': 0, 'contexts': 0, 'pages': 0, 'test': None,
          'stream': None, 'stream_pid': None}
_ordinals = {}


def root():
    return os.environ.get('KIN_TRANSPORT_DIAG_DIR') or ''


def installed():
    return _state['installed']


def redact_url(url):
    """Query values and fragments never reach a record; source reads carry no query, so the path stays exact."""
    try:
        parts = urlsplit(str(url))
    except ValueError:
        return '[unparseable URL]'
    if not parts.query and not parts.fragment:
        return str(url)
    query = '&'.join(key + '=' + ('[REDACTED]' if value else '') for key, value in parse_qsl(parts.query, keep_blank_values=True))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ''))


def _error(error):
    return '%s: %s' % (type(error).__name__, error)


def _safe(read):
    try:
        return read()
    except Exception as error:
        return '<unavailable: %s>' % type(error).__name__


def _stream():
    if _state['stream'] is None or _state['stream_pid'] != os.getpid():
        folder = root()
        os.makedirs(folder, exist_ok=True)
        _state['stream'] = open(os.path.join(folder, 'events-%d.jsonl' % os.getpid()), 'a', encoding='utf-8')
        _state['stream_pid'] = os.getpid()
    return _state['stream']


def record(kind, **fields):
    try:
        with _lock:
            _state['seq'] += 1
            row = {'seq': _state['seq'], 'kind': kind, 'wall': time.time(), 'monotonic': time.monotonic(), 'pid': os.getpid(),
                   'test': _state['test']}
            row.update(fields)
            stream = _stream()
            stream.write(json.dumps(row, ensure_ascii=False, default=str) + '\n')
            stream.flush()
    except Exception:
        pass


def _next(counter):
    with _lock:
        _state[counter] += 1
        return _state[counter]


def _remember(obj, ordinal):
    with _lock:
        _ordinals[id(obj)] = (obj, ordinal)


def _ordinal(obj):
    entry = _ordinals.get(id(obj))
    return entry[1] if entry is not None and entry[0] is obj else None


class _AfterImport(importlib.abc.MetaPathFinder):
    """Runs callback(module) right after one named module has executed; finding and loading stay Python's own."""

    def __init__(self, name, callback):
        self.name, self.callback = name, callback

    def find_spec(self, fullname, path=None, target=None):
        if fullname != self.name:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is None or spec.loader is None or not hasattr(spec.loader, 'exec_module'):
            return spec
        original, callback = spec.loader.exec_module, self.callback

        def exec_module(module):
            original(module)
            try:
                callback(module)
            except Exception as error:
                record('hook_error', where='patch', error=_error(error))

        spec.loader.exec_module = exec_module
        return spec


def install(target=TARGET):
    with _lock:
        if _state['installed']:
            return False
        _state['installed'] = True
    record('hook', python=sys.version.split()[0], argv=[os.path.basename(arg) for arg in sys.argv[:3]], target=target)
    if target in sys.modules:
        patch(sys.modules[target])
    else:
        sys.meta_path.insert(0, _AfterImport(target, patch))
    return True


def _wrap(owner, name, make):
    original = getattr(owner, name, None) if owner is not None else None
    if original is None or getattr(original, MARK, False):
        return False
    wrapper = functools.wraps(original)(make(original))
    setattr(wrapper, MARK, True)
    setattr(owner, name, wrapper)
    return True


def _describe(pattern):
    if pattern is None or isinstance(pattern, str):
        return pattern
    if hasattr(pattern, 'pattern'):
        return 're:' + str(pattern.pattern)
    return '<%s>' % (getattr(pattern, '__name__', None) or type(pattern).__name__)


def _launch(original):
    def launch(self, *args, **kwargs):
        number, given, extra = _next('launches'), kwargs.get('args'), None
        try:
            folder = os.path.join(root(), 'netlog')
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, 'netlog-%d-%d.json' % (os.getpid(), number))
            extra = ['--log-net-log=' + path, CAPTURE_MODE]
            record('launch', launch=number, netlog=path, caller_args=list(given or []), added_args=extra,
                   headless=kwargs.get('headless'), channel=kwargs.get('channel'))
        except Exception as error:
            extra = None
            record('hook_error', where='launch', error=_error(error))
        call = dict(kwargs, args=list(given or []) + extra) if extra else kwargs
        started = time.monotonic()
        try:
            browser = original(self, *args, **call)
        except BaseException as error:
            record('launch_failed', launch=number, seconds=round(time.monotonic() - started, 3), error=type(error).__name__)
            raise
        _remember(browser, number)
        record('launched', launch=number, seconds=round(time.monotonic() - started, 3), version=_safe(lambda: browser.version))
        return browser
    return launch


def _observe_context(context, browser):
    if _ordinal(context) is not None:
        return _ordinal(context)
    number = _next('contexts')
    _remember(context, number)
    record('context', context=number, browser=_ordinal(browser))
    # Playwright passes a handler as many event arguments as its signature has parameters; partials expose only the event's own.
    context.on('page', functools.partial(_on_page, number))
    context.on('requestfailed', functools.partial(_on_failed, number))
    context.on('close', functools.partial(_closed, 'context_closed', 'context', number))
    return number


def _closed(kind, key, number, *_):
    record(kind, **{key: number})


def _new_context(original):
    def new_context(self, *args, **kwargs):
        context = original(self, *args, **kwargs)
        try:
            _observe_context(context, self)
        except Exception as error:
            record('hook_error', where='new_context', error=_error(error))
        return context
    return new_context


def _new_page(original):
    def new_page(self, *args, **kwargs):
        page = original(self, *args, **kwargs)
        try:
            number = _observe_context(page.context, self)
            if _ordinal(page) is None:
                _on_page(number, page)
        except Exception as error:
            record('hook_error', where='new_page', error=_error(error))
        return page
    return new_page


def _close(original):
    def close(self, *args, **kwargs):
        started = time.monotonic()
        record('browser_close', launch=_ordinal(self))
        try:
            return original(self, *args, **kwargs)
        finally:
            record('browser_closed', launch=_ordinal(self), seconds=round(time.monotonic() - started, 3))
    return close


def _routing(owner_label, name):
    def make(original):
        def method(self, *args, **kwargs):
            pattern = _describe(args[0] if args else kwargs.get('url', kwargs.get('har')))
            try:
                result = original(self, *args, **kwargs)
            except BaseException as error:
                record('route', owner=owner_label, owner_ordinal=_ordinal(self), method=name, pattern=pattern, error=type(error).__name__)
                raise
            record('route', owner=owner_label, owner_ordinal=_ordinal(self), method=name, pattern=pattern)
            return result
        return method
    return make


def _on_page(context_number, page):
    try:
        if _ordinal(page) is not None:
            return
        number = _next('pages')
        _remember(page, number)
        record('page', context=context_number, page=number)
        page.on('close', functools.partial(_closed, 'page_closed', 'page', number))
    except Exception as error:
        record('hook_error', where='page', error=_error(error))


def _on_failed(context_number, request):
    try:
        url = str(request.url)
        parts = urlsplit(url)
        try:
            page = _ordinal(request.frame.page)
        except Exception:
            page = None
        record('requestfailed', context=context_number, page=page, method=_safe(lambda: request.method), url=redact_url(url),
               host=parts.netloc, path=parts.path, resource_type=_safe(lambda: request.resource_type),
               failure=_safe(lambda: request.failure), navigation=_safe(lambda: request.is_navigation_request()),
               source_read=parts.netloc.endswith(ORIGIN_SUFFIX) and parts.path.startswith(SOURCE_PREFIXES),
               timing=_safe(lambda: dict(request.timing)))
    except Exception as error:
        record('hook_error', where='requestfailed', error=_error(error))


def _patch_unittest():
    import unittest.result
    base = unittest.result.TestResult

    def start(original):
        def startTest(self, test):
            _state['test'] = _safe(test.id)
            record('test_start')
            return original(self, test)
        return startTest

    def stop(original):
        def stopTest(self, test):
            try:
                return original(self, test)
            finally:
                record('test_stop')
                _state['test'] = None
        return stopTest

    def outcome(label):
        def make(original):
            def add(self, test, *args, **kwargs):
                record('test_outcome', outcome=label)
                return original(self, test, *args, **kwargs)
            return add
        return make

    wrapped = {'startTest': _wrap(base, 'startTest', start), 'stopTest': _wrap(base, 'stopTest', stop)}
    for name, label in (('addSuccess', 'success'), ('addFailure', 'failure'), ('addError', 'error'), ('addSkip', 'skip')):
        wrapped[name] = _wrap(base, name, outcome(label))
    return wrapped


def patch(module):
    with _lock:
        if _state['patched']:
            return
        _state['patched'] = True
    done = {'unittest': _patch_unittest(),
            'BrowserType.launch': _wrap(getattr(module, 'BrowserType', None), 'launch', _launch),
            'Browser.new_context': _wrap(getattr(module, 'Browser', None), 'new_context', _new_context),
            'Browser.new_page': _wrap(getattr(module, 'Browser', None), 'new_page', _new_page),
            'Browser.close': _wrap(getattr(module, 'Browser', None), 'close', _close)}
    for owner in ('BrowserContext', 'Page'):
        for name in ('route', 'unroute', 'unroute_all', 'route_from_har'):
            done[owner + '.' + name] = _wrap(getattr(module, owner, None), name, _routing(owner, name))
    record('patched', module=getattr(module, '__name__', None), wrapped=done)
