# coding: utf-8
"""S5-U1a clinician role and clinician-only default denial, S5-U1b read allowlist: pure stdlib spec and source check.

REQ-S5-U1a-ROLE-DEFAULT-DENY -> RISK-S5-CLINICIAN-WRITER-LEAK/UNCLASSIFIED-ROUTE/ROLE-LIST-DRIFT
-> TEST-S5-U1a-CLINICIAN-POLICY (this file) and TEST-S5-U1a-CLINICIAN-LIVE (clinician_policy_live.py).
REQ-S5-U1b-CLINICIAN-READ -> RISK-S5-U1b-DRAFT-LEAK/NONFINAL-BODY/WRITER-FIELD/COUNT-LEAK/TENANT-UID
-> this file (allowlist == fixture, declared additions only, source pins), TEST-S5-U1b-PURE
(clinician_read_serializer_test.cjs) and TEST-S5-U1b-LIVE (clinician_read_live.py).
REQ-S5-U1c-ROUTE-COMPLETENESS -> RISK-S5-U1c-NEW-ROUTE-LEAK/MIXED-DOWNGRADE -> TEST-S5-U1c-INVENTORY (test_05, test_11-23
here) and TEST-S5-U1c-LIVE-MATRIX (clinician_policy_live.py test_01/test_04/test_05): every controller route has exactly one
route_matrix row, nothing is denied by subtraction, and review notes D3/D5/D6/D8 of S5-U1a are closed by pins.

No Node, no Nest, no browser, no stack. Three kinds of evidence and nothing more:
  1. tests/clinician_policy_fixtures.json judged by an independent Python model of the guard rules
     (member state, clinician-only detection, gateway identity closure, route key from Nest metadata,
     allowlist decision). The shipped TypeScript is judged against the same fixtures only by the hosted
     live module; a green run here is a spec check, not runtime proof of the TS.
  2. The current controller decorator inventory (own parser: decorator runs, so a @Public() belongs to the handler it
     decorates, same decorator table as invariants_live; every '@' outside comments and literals must be a decorator
     call it reads, spaced or not, or it refuses the file; a '//' comment ends at any of the four line terminators, and
     every other api/src .ts file goes through the same reader and may carry no route, @Controller() or @Public(); every
     decorator name is bound once by 'import { Name }' from its listed module and nothing renames, re-exports under
     another name or shadows it, and Public ends at its declaration in auth.guard.ts; a route, Controller,
     RequestMapping, Public or SetMetadata name occurs in code only as its import and as a decorator the runs read, and
     no Reflect metadata writer, decorator factory or loader of Nest or a project file reaches that metadata another way;
     tests/clinician_policy_fixtures.json source_contract is the closed list of forms that reach a loader, an evaluator,
     a metadata writer or a class prototype, and every other form is refused; a '/' is a regex or a division by the
     token before it, a '/' whose reading turns on grammar the lexer does not track refuses the file, and no regex
     literal spells a checked name, S5-U1c-F07; every class heading is read to the '{' of its body past type parameters
     and heritage clauses, and no class in a controller file extends, S5-U1c-F08) compared with the invariants_live
     ROUTES table read as text,
     with the 104-row planning baseline and with the route matrix: every current route is public, a listed session or
     business row, or a denied row with a named basis, and every route added since the baseline has its own row.
  3. Source pins that guard, member console, Keycloak client and realm carry the same role list and that
     the gate sits between the membership check and the CSRF rule in the guard.
"""
from __future__ import annotations

import functools
import json
import os
import re
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "api" / "src"
POLICY = API / "clinician-policy.ts"
GUARD = API / "auth.guard.ts"
ADMIN = API / "admin.service.ts"
KEYCLOAK = API / "keycloak.service.ts"
REALM = ROOT / "keycloak" / "kin-realm.json"
MANIFEST = ROOT / "tests" / "invariants_live.py"
LIVE_MODULE = ROOT / "tests" / "clinician_policy_live.py"
QUESTION_LIVE = ROOT / "tests" / "clinician_question_live.py"
LOCKFILE = ROOT / "api" / "package-lock.json"
FIXTURES = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))

APP_ROLES = set(FIXTURES["app_roles"])
LEGACY_ROLES = set(FIXTURES["legacy_roles"])
CLINICIAN = FIXTURES["clinician_role"]
KIN_ROLES = APP_ROLES | {"gateway"}
ALLOWED = set(FIXTURES["session_routes"]) | set(FIXTURES["business_routes"])
PUBLIC = set(FIXTURES["public_routes"])
METHOD_ENUM = {int(k): v for k, v in FIXTURES["request_method_enum"].items()}
BASELINE = set(FIXTURES["baseline_inventory"]["routes"])
SESSION = set(FIXTURES["session_routes"])
BUSINESS = set(FIXTURES["business_routes"])
MATRIX = FIXTURES["route_matrix"]
DENIED_GROUPS = MATRIX["denied"]
DENIED_ROUTES = {route for routes in DENIED_GROUPS.values() for route in routes}


# ── independent model of the guard ──

def strip_groups(groups):
    return [g[1:] if g.startswith("/") else g for g in (groups or []) if isinstance(g, str)]


def member_state(groups, roles):
    app = [r for r in (roles if isinstance(roles, list) else []) if r in APP_ROLES]
    if len(groups) == 0:
        return "PENDING"
    if len(groups) == 1 and len(app) >= 1:
        return "APPROVED"
    return "INVALID"


def clinician_only(roles):
    app = [r for r in (roles if isinstance(roles, list) else []) if r in APP_ROLES]
    return len(app) > 0 and all(r == CLINICIAN for r in app)


def gateway_identity(method, azp, groups, roles):
    kin = [r for r in roles if r in KIN_ROLES]
    adjacent = azp.startswith("gw-") or "gateway" in kin
    valid = method == "bearer" and azp.startswith("gw-") and len(groups) == 1 and kin == ["gateway"]
    return adjacent, valid


def segments(value):
    if not isinstance(value, str):
        return None
    return [part for part in value.split("/") if part]


def route_key(method, controller, handler):
    if type(method) is not int:
        return None
    name = METHOD_ENUM.get(method)
    if name is None:
        return None
    prefix, child = segments(controller), segments(handler)
    if prefix is None or child is None:
        return None
    return name + " " + "/".join(prefix + child)


def allowed(key):
    return key is not None and key in ALLOWED


# ── source readers ──

HTTP_DECORATORS = {"All": "ALL", "Get": "GET", "Post": "POST", "Put": "PUT", "Delete": "DELETE",
                   "Patch": "PATCH", "Options": "OPTIONS", "Head": "HEAD", "Search": "SEARCH", "Sse": "GET"}
ROUTE_NAMES = "|".join(map(re.escape, HTTP_DECORATORS))
KNOWN_DECORATORS = set(HTTP_DECORATORS) | set(FIXTURES["controller_decorators"]["non_route"])
OUTSIDE_DECORATORS = set(FIXTURES["outside_decorators"]["classified"])
# the names that declare a route or open one; outside *.controller.ts neither inventory would see them (S5-U1c-F03)
DECIDING = frozenset({"Public", "Controller", "RequestMapping", *HTTP_DECORATORS})
BINDINGS = FIXTURES["decorator_bindings"]
# the one module each name the runs may carry is imported from, by that name. The inventories classify a decorator by its
# name, so '@Header()' is Nest's Header only when the file says so: 'import { Get as Header }' read as a header (S5-U1c-F04).
DECORATOR_MODULE = {name: module for module, names in BINDINGS["modules"].items() for name in names}
# no import or export renames one of these, from or to: an alias is how a route or @Public() takes a harmless name
BOUND_NAMES = frozenset(DECORATOR_MODULE) | DECIDING
IMPORT_FORMS = frozenset({"named", "namespace", "default", "equals"})
PUBLIC_MODULE = API / (DECORATOR_MODULE["Public"][2:] + ".ts")
# the names a route, a controller or public metadata is made with; SetMetadata is what Public calls. Each occurs in code
# only as the local name of its import and as a decorator the runs read. 'Put('x')(target, key, descriptor)' after the
# class, the name handed to a variable, an array, applyDecorators or Reflect.decorate, 'common.Get' and an export apply
# or pass on what neither inventory reads: 'import { Put }' plus such a call made a public route both missed
# (S5-U1c-F05). RequestMapping, which no run may carry, is Nest's export too.
METADATA_WRITER = BINDINGS["public_metadata_import"]["name"]
STRICT_NAMES = DECIDING | {METADATA_WRITER}
STRICT_MODULE = {**{name: DECORATOR_MODULE.get(name, "@nestjs/common") for name in DECIDING},
                 METADATA_WRITER: BINDINGS["public_metadata_import"]["module"]}
STRICT_NAME = re.compile(rf"(?:{'|'.join(sorted(STRICT_NAMES))})(?![\w$])")
# what writes the same metadata under none of those names: reflect-metadata ('Reflect.defineMetadata('path', ...)' is a
# route) and Nest's decorator factory ('Reflector.createDecorator({ key: 'public' })' is a @Public()). Reflect occurs only
# as 'Reflect.<member>' of a member source_contract lists, so it is not handed on either.
METADATA_WRITERS = frozenset({"defineMetadata", "decorate", "createDecorator"})
WRITER_NAME = re.compile(rf"(?:{'|'.join(sorted(METADATA_WRITERS))})(?![\w$])")
REFLECT_NAME = re.compile(r"Reflect(?![\w$])")
# a loader hands back a module object whose members no name check reads: require('@nestjs/common')['Put'] is a route
LOADER_NAME = re.compile(r"(require|import)(?![\w$])")
IDENTIFIER_CHAR = re.compile(r"[\w$]")
# S5-U1c-F06: the closed source contract. A loader, an evaluator, a metadata writer and a class prototype are reached
# only in the forms source_contract lists and every other form is refused; its rule field is what the checks implement.
CONTRACT = FIXTURES["source_contract"]
PACKAGES = frozenset(CONTRACT["packages"])
LOADED_PACKAGES = frozenset(CONTRACT["loaded_packages"])
REFLECT_MEMBERS = frozenset(CONTRACT["reflect_members"])
PROCESS_MEMBERS = frozenset(CONTRACT["process_members"])
PROTOTYPE_OWNERS = frozenset(CONTRACT["prototype_owners"])
SEALED_WORD = re.compile(rf"(?:{'|'.join(sorted(map(re.escape, CONTRACT['sealed_words'])))})(?![\w$])")
OWNER_NAME = re.compile(rf"(?:{'|'.join(sorted(PROTOTYPE_OWNERS))})(?![\w$])")
PROCESS_NAME = re.compile(r"process(?![\w$])")
PROTOTYPE_NAME = re.compile(r"prototype(?![\w$])")
GET_PROTOTYPE_NAME = re.compile(r"getPrototypeOf(?![\w$])")
CONSTRUCTOR_NAME = re.compile(r"constructor(?![\w$])")
# every name the name checks read, which regex_names finds in no regex literal (S5-U1c-F07)
CHECKED_NAMES = (STRICT_NAME, WRITER_NAME, REFLECT_NAME, LOADER_NAME, SEALED_WORD, OWNER_NAME, PROCESS_NAME,
                 PROTOTYPE_NAME, GET_PROTOTYPE_NAME, CONSTRUCTOR_NAME)
RETURN_WORD = re.compile(r"(?<![\w$.])return(?![\w$])")
CLASS_WORD = re.compile(r"(?<![\w$.])class(?![\w$])")
EXTENDS_WORD = re.compile(r"(?<![\w$.])extends(?![\w$])")
# S5-U1c-F08: the words that open a heritage clause, and what a type between '<' and '>' is written with besides names,
# numbers, '=>' and the brackets angle_end skips whole
HERITAGE_WORDS = frozenset({"extends", "implements"})
TYPE_PUNCT = frozenset(",.=|&?:-")
# what stands before a method named require in a class body: the end of the member before it, or a modifier
MEMBER_START = frozenset({"{", "}", ";", "async", "public", "private", "protected", "static", "override"})
KEY_NAME = re.compile(r"[A-Za-z_$][\w$]*")
# a string that spells one of these reaches it by a reflective call as well as by a key
# (Object.getOwnPropertyDescriptor(X, 'prototype'), { '__proto__': p }, 'constructor'() { ... }); only an array literal
# may hold one, as the real reserved-key set does
STRING_HANDLES = frozenset(CONTRACT["sealed_words"]) | frozenset(CONTRACT["sealed_strings"])
# a keyword before Object or Array that declares the name, which would let 'Object.prototype' name something else
DECLARING = frozenset({"class", "function", "interface", "type", "enum", "namespace", "const", "let", "var", "as",
                       "import"})
STRING_ESCAPE = re.compile(r"\\(?:u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|(\r\n|[\s\S]))")
SIMPLE_ESCAPES = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "0": "\0"}
# tsconfig compiles src/**/*, which takes .tsx, .mts and .cts too; a script no inventory opens could hold a controller
UNREAD_SCRIPTS = frozenset({".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"})
# TypeScript accepts whitespace, a line break or a comment between '@', the name and '('. A reader that wanted '@Name('
# never saw '@Public ()' and kept that handler private (S5-U1c-F01); comments are blanked by code_mask before this runs.
DECORATOR_CALL = re.compile(r"@\s*([A-Za-z_$][\w$]*)\s*\(")
# argument readers run on the raw text: a comment or an expression inside the call is refused, not read around
ROUTE_TEXT = re.compile(rf"@\s*({ROUTE_NAMES})\s*\(\s*(?:(['\"])([^'\"\\\n]*)\2)?\s*\)")
CONTROLLER_TEXT = re.compile(r"@\s*Controller\s*\(\s*(?:(['\"])([^'\"\\\n]*)\1)?\s*\)")
# ECMAScript LineTerminator, the four TypeScript's scanner also breaks lines at (isLineBreak): a '//' comment ends at the
# first of them. Ending it at LF only read '// note<U+2028>@Public /* c */ ()' as one comment and kept that handler
# private (S5-U1c-F02).
LINE_TERMINATORS = "\n\r\u2028\u2029"
LINE_END = re.compile("[\n\r\u2028\u2029]")
# TypeScript's single-line whitespace (isWhiteSpaceSingleLine) and the line terminators. str.isspace() is another set: it
# takes U+001C-U+001F, which TypeScript rejects, and misses U+200B and U+FEFF, which TypeScript skips.
WHITESPACE = frozenset(map(chr, (0x09, 0x0B, 0x0C, 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200C), 0x202F, 0x205F,
                                 0x3000, 0xFEFF))) | frozenset(LINE_TERMINATORS)
# one part of a dotted name as written; an identifier may spell any of its characters as a \u escape
NAME_PART = re.compile(r"(?:[\w$]|\\u[0-9A-Fa-f]{4}|\\u\{[0-9A-Fa-f]+\})+")
NAME_ESCAPE = re.compile(r"\\u(?:([0-9A-Fa-f]{4})|\{([0-9A-Fa-f]+)\})")
# what can follow a decorator's name: its call, type arguments, the ')' of '@(Name)()', '!', '?.', '[' or a template
AFTER_NAME = frozenset("(<)!?[`")
# words an operand follows where they are keywords: a '[' after one opens an array literal (array_literal)
REGEX_WORDS = frozenset({"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do",
                         "else", "yield", "await"})
# S5-U1c-F07: a '/' opens a regex literal or divides by the token before it, read as a token in its expression. The
# reader before this looked at one character, and '+', '-' and '}' opened a regex, so 'probe++ / (() => { ...
# Reflect.defineMetadata(...) ... })() / 1' was a regex from the first '/' to the second and the metadata writes between
# them were blanked before any name or loader check read the code. Each token now says what a '/' right after it is:
# REGEX, DIVISION, or the reason the lexer refuses the source because TypeScript's reading turns on grammar it does not
# track. Neither reading is guessed there: a regex read as a division is no safer, since a quote in its body would open
# a string over the code after it.
REGEX, DIVISION = "regex", "division"
# the reserved words an operand follows: a '/' after one opens a regex unless it is a property name ('x.return / 2')
OPERAND_WORDS = frozenset({"return", "typeof", "instanceof", "in", "new", "delete", "throw", "case", "do", "else"})
# words after which TypeScript's reading is the grammar's: 'of', 'await' and 'yield' are keywords an operand follows in
# one statement and names in another, 'void' is the operator or, after 'as' or 'satisfies', a type that divides
# ('(x as any) satisfies void / 2'), and no '/' follows the others but a statement that ends ('break\n/x/.test(s)')
UNREAD_WORDS = frozenset({"await", "of", "void", "yield", "break", "catch", "class", "const", "continue", "debugger",
                          "default", "enum", "export", "extends", "finally", "for", "function", "if", "implements",
                          "import", "interface", "let", "package", "private", "protected", "public", "static", "switch",
                          "try", "var", "while", "with"})
# a statement follows the ')' of these headers, and 'for await (' is one; after any other ')' an expression has ended
CONTROL_WORDS = frozenset({"if", "while", "for", "with"})
# the punctuators an operand follows; '=>', '...', '++' and '--' are read whole, and '++', '--' and '!' by whether they
# are postfix
OPERAND_PUNCT = frozenset({"(", "[", "{", ",", ";", ":", "?", "=", "+", "-", "*", "%", "&", "|", "^", "~", "<", "=>",
                           "...", "/", "${"})
UNREAD_PUNCT = {
    "}": "'}' ends a block, after which a '/' opens a regex, or an object literal, a type or a class or function "
         "expression, after which it divides",
    ">": "'>' compares, after which a '/' opens a regex, or closes type arguments ('f<T> / 2'), after which it divides",
    ".": "a member name follows '.'",
}
# a numeric literal as TypeScript scans it, so '1.' and '.5' are numbers and '1.in x' is not the property 'in'
NUMBER = re.compile(r"0[xXoObB][0-9A-Fa-f_]+n?|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]+)?n?")
IDENTIFIER = re.compile(r"[\w$]+")
# an import or export keyword of the code; one after '.' is a property (import.meta is read where the keyword is)
STATEMENT_KEYWORD = re.compile(r"(?<![\w$.])(import|export)(?![\w$])")


def literal_end(source, start):
    """Offset past the string or regex literal that opens at source[start]; neither may run over a line terminator.

    A regex holds none of the four, escaped or not. A string goes on over an escaped one only; a bare U+2028/U+2029 is
    string content since ES2019, but it is refused here, so the reader never depends on which rule a compiler applies.
    """
    closer, index, in_class = source[start], start + 1, False
    while index < len(source):
        char = source[index]
        if char == "\\" and closer != "/":
            index += 3 if source.startswith("\r\n", index + 1) else 2
            continue
        if char in LINE_TERMINATORS:
            break
        if char == "\\":
            if index + 1 < len(source) and source[index + 1] in LINE_TERMINATORS:
                break
            index += 2
            continue
        if closer == "/" and in_class:
            in_class = char != "]"
        elif closer == "/" and char == "[":
            in_class = True
        elif char == closer:
            index += 1
            if closer == "/" and (flags := IDENTIFIER.match(source, index)):
                index = flags.end()
            return index
        index += 1
    raise AssertionError(f"unterminated literal at offset {start}: {source[start:start + 40]!r}")


def template_part(source, index):
    """From inside a template literal to past its closing '`' (False) or past its next '${' (True)."""
    while index < len(source):
        if source[index] == "\\":
            index += 2
        elif source[index] == "`":
            return index + 1, False
        elif source.startswith("${", index):
            return index + 2, True
        else:
            index += 1
    raise AssertionError("unterminated template literal")


@functools.lru_cache(maxsize=None)
def code_mask(source):
    """source with comments and string, template and regex literals blanked; offsets and line terminators are kept.

    What is left is code, so every '@' in it is a decorator candidate (S5-U1c-F01). A literal, comment or bracket that
    does not close raises, and so does a '/' no rule reads as a regex or a division (S5-U1c-F07): a reader that lost
    its place would otherwise hide the code after it.
    """
    return lexed(source)[0]


@functools.lru_cache(maxsize=None)
def lexed(source):
    """(code_mask text, strings, regexes): strings holds the (start, end) of every '...' or "..." literal and every
    template without substitutions, which literal_keys reads for the names they spell (S5-U1c-F06), regexes the (start,
    end) of every regex literal, whose text regex_names reads (S5-U1c-F07).

    tokens holds (text, slash, end, member) of each token of the code: what a '/' right after it is (REGEX, DIVISION
    or the reason it is refused), where it ends, and for a name whether it follows '.' or '#'.
    """
    out, stack, index, strings, regexes, tokens = list(source), [], 0, [], [], []

    def blank(start, end):
        out[start:end] = [char if char in LINE_TERMINATORS else " " for char in source[start:end]]

    def before(start):
        """(text, slash, line) of the token before source[start]; line is True when a line terminator, in a comment or
        not, stands between them, which is where TypeScript inserts a semicolon."""
        if not tokens:
            return "", REGEX, False
        text, slash, end, _member = tokens[-1]
        return text, slash, any(char in LINE_TERMINATORS for char in source[end:start])

    def fixity(start, text):
        """What a '/' after the '++', '--' or '!' at source[start] is: postfix (the non-null assertion for '!') right
        after a token an expression ends at, on its line, and a division follows; prefix, and a regex follows; or the
        token before is one the lexer refuses to read, and so is this one."""
        previous, slash, line = before(start)
        if slash in (REGEX, DIVISION):
            return DIVISION if slash == DIVISION and not line else REGEX
        return f"{text!r} is postfix or prefix as {previous!r} reads, which is refused: {slash}"

    while index < len(source):
        char, start = source[index], index
        if char in WHITESPACE:
            index += 1
        elif source.startswith("//", index):
            end = LINE_END.search(source, index)
            index = len(source) if end is None else end.start()
            blank(start, index)
        elif source.startswith("/*", index):
            index = source.find("*/", index + 2)
            if index < 0:
                raise AssertionError(f"unterminated comment at offset {start}")
            index += 2
            blank(start, index)
        elif char in "'\"":
            index = literal_end(source, start)
            blank(start, index)
            strings.append((start, index))
            tokens.append(("<string>", DIVISION, index, False))
        elif char == "/":
            previous, slash, line = before(start)
            if slash == DIVISION and line:
                slash = ("it starts a line after a token an expression ends at, so it divides, or opens a regex after a "
                         "semicolon inserted where a statement or a type annotation ends, as the grammar reads")
            if slash not in (REGEX, DIVISION):
                raise AssertionError(f"a '/' the lexer does not read as a regex or a division from the token before it "
                                     f"({previous!r}) at offset {start}: {slash}: "
                                     f"{' '.join(source[max(0, start - 40):start + 40].split())!r}")
            if slash == REGEX:
                index = literal_end(source, start)
                blank(start, index)
                regexes.append((start, index))
                tokens.append(("<regex>", DIVISION, index, False))
            else:
                index += 1
                tokens.append(("/", REGEX, index, False))
        elif char == "`" or (char == "}" and stack and stack[-1] == "${"):
            if char == "}":
                stack.pop()
            index, opened = template_part(source, index + 1)
            blank(start, index)
            if opened:
                stack.append("${")
            elif char == "`":
                strings.append((start, index))
            tokens.append(("${", REGEX, index, False) if opened else ("<template>", DIVISION, index, False))
        elif char in "0123456789" or char == "." and source[index + 1:index + 2] in tuple("0123456789"):
            index = NUMBER.match(source, index).end()
            if index < len(source) and (IDENTIFIER_CHAR.match(source[index]) or source[index] == "\\"):
                raise AssertionError(f"a name or digit right after the numeric literal at offset {start}: "
                                     f"{source[start:start + 30]!r}")
            tokens.append(("<number>", DIVISION, index, False))
        elif char.isalnum() or char in "_$":
            word = IDENTIFIER.match(source, index).group(0)
            index += len(word)
            member = bool(tokens) and tokens[-1][0] in (".", "#")
            if member or word not in OPERAND_WORDS | UNREAD_WORDS:
                slash = DIVISION
            elif word in OPERAND_WORDS:
                slash = REGEX
            else:
                slash = (f"{word!r} is a keyword or a name as the statement reads, after which a '/' opens a regex or "
                         f"divides")
            tokens.append((word, slash, index, member))
        else:
            text = next((mark for mark in ("=>", "...", "++", "--") if source.startswith(mark, index)), char)
            index += len(text)
            if text in ("(", "[", "{"):
                # the '(' of a control header is kept as 'if(', so its ')' says a statement follows
                if text == "(" and tokens and not tokens[-1][3] and (tokens[-1][0] in CONTROL_WORDS or (
                        tokens[-1][0] == "await" and len(tokens) > 1 and tokens[-2][0] == "for" and not tokens[-2][3])):
                    text = "if("
                stack.append(text)
                slash = REGEX
            elif text in (")", "]", "}"):
                opened = stack.pop() if stack else None
                if opened is None or opened[-1] != {")": "(", "]": "[", "}": "{"}[text]:
                    raise AssertionError(f"{text!r} at offset {start} closes {opened!r}")
                slash = REGEX if opened == "if(" else UNREAD_PUNCT["}"] if text == "}" else DIVISION
            elif text in ("++", "--", "!"):
                slash = fixity(start, text)
            elif text in OPERAND_PUNCT:
                slash = REGEX
            else:
                slash = UNREAD_PUNCT.get(text, f"no rule reads a '/' after {text!r}")
            tokens.append((text, slash, index, False))
    if stack:
        raise AssertionError(f"unclosed {stack} at the end of the source")
    return "".join(out), tuple(strings), tuple(regexes)


def call_end(code, open_paren):
    """Offset just past the ')' that closes code[open_paren]; code is masked, so no literal parenthesis is left."""
    depth = 0
    for index in range(open_paren, len(code)):
        if code[index] == "(":
            depth += 1
        elif code[index] == ")":
            depth -= 1
            if depth == 0:
                return index + 1
    raise AssertionError(f"unbalanced decorator call at offset {open_paren}")


def decorator_runs(source):
    """Decorators separated only by whitespace or comments are one run: {'kind', 'items': [(name, start, end)]}.

    A run right after '(' or ',' decorates a parameter, one followed by `class` decorates the class, any other
    decorates a member. Reading runs, not the text between two route decorators, is what attributes a @Public()
    to the handler it sits on whatever the order (S5-U1c D5). Every '@' left in the code is a candidate; one that is
    not a plain '@Name(...)' call is refused, and the items read must be exactly the candidates (S5-U1c-F01).
    """
    code = code_mask(source)
    candidates = [match.start() for match in re.finditer("@", code)]
    unsupported = [source[at:at + 40] for at in candidates if DECORATOR_CALL.match(code, at) is None]
    if unsupported:
        raise AssertionError(f"decorator shapes the inventory does not read: {unsupported}")
    runs, cursor = [], 0
    for first in candidates:
        if first < cursor:
            continue
        items, at = [], first
        while at < len(code) and code[at] == "@":
            match = DECORATOR_CALL.match(code, at)
            end = call_end(code, match.end() - 1)
            items.append((match.group(1), at, end))
            at = end
            while at < len(code) and code[at].isspace():
                at += 1
        before = code[:first].rstrip()
        after = code[items[-1][2]:].lstrip()
        if before.endswith(("(", ",")):
            kind = "parameter"
        elif re.match(r"(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\b", after):
            kind = "class"
        else:
            kind = "member"
        runs.append({"kind": kind, "items": items})
        cursor = items[-1][2]
    read = [start for run in runs for _name, start, _end in run["items"]]
    if read != candidates:
        raise AssertionError(f"decorators inside another decorator's call: {sorted(set(candidates) - set(read))}")
    return runs


def skip_gap(source, index):
    """Offset past the whitespace and comments at source[index]; a block comment that does not close runs to the end."""
    while index < len(source):
        if source[index] in WHITESPACE or source[index].isspace():
            index += 1
        elif source.startswith("/*", index):
            end = source.find("*/", index + 2)
            index = len(source) if end < 0 else end + 2
        elif source.startswith("//", index):
            end = LINE_END.search(source, index)
            index = len(source) if end is None else end.start()
        else:
            break
    return index


def name_text(part):
    """A name part as the compiler reads it: its \\u escapes decoded."""
    def decode(match):
        code = int(match.group(1) or match.group(2), 16)
        return chr(code) if code <= 0x10FFFF else match.group(0)
    return NAME_ESCAPE.sub(decode, part)


def decorator_text(source):
    """[(offset, text)] for every '@' of the raw text, comments and literals included, that starts a decorator naming a
    route decorator, @Controller(), @RequestMapping() or @Public() in any spelling TypeScript takes: whitespace, line
    terminators and comments around every part, '(' before the name, a dotted name, \\u escapes in it.

    It does not trust code_mask: every hit must be a decorator the inventory read, so neither text the lexer wrongly
    blanked nor a commented-out decorator can hide one. A name that no call, type argument or ')' follows is prose
    ('@Public 제외' in a doc comment), not a decorator (S5-U1c-F02).
    """
    hits = []
    for at in (match.start() for match in re.finditer("@", source)):
        index = skip_gap(source, at + 1)
        while source.startswith("(", index):
            index = skip_gap(source, index + 1)
        names = []
        while part := NAME_PART.match(source, index):
            names.append(name_text(part.group(0)))
            index = skip_gap(source, part.end())
            if not source.startswith(".", index):
                break
            index = skip_gap(source, index + 1)
        if DECIDING.intersection(names) and index < len(source) and source[index] in AFTER_NAME:
            hits.append((at, source[at:index + 1]))
    return hits


def next_token(source, index):
    """(kind, text, start, end) of the token after the whitespace and comments at source[index]: 'name' (\\u escapes
    decoded), 'string' (the raw text between its quotes), 'punct' (one character) or 'end'."""
    start = skip_gap(source, index)
    if start >= len(source):
        return "end", "", start, start
    if source[start] in "'\"":
        end = literal_end(source, start)
        return "string", source[start + 1:end - 1], start, end
    part = NAME_PART.match(source, start)
    if part:
        return "name", name_text(part.group(0)), start, part.end()
    return "punct", source[start], start, start + 1


def module_key(path, specifier):
    """A relative module as './<path from api/src>', resolved from the importing file; a package as written."""
    if not specifier.startswith(("./", "../")):
        return specifier
    target = Path(os.path.normpath(path.parent / specifier))
    try:
        return "./" + target.relative_to(API).as_posix()
    except ValueError:
        return "outside api/src: " + target.as_posix()


def whole_module(key):
    """A module no namespace, default, import = or export * may bind: one a decorator name is imported from, any Nest
    package, and a project file, whose exports would be read as properties no name check follows (S5-U1c-F06)."""
    return key is not None and (key in BINDINGS["modules"] or key.startswith(("@nestjs/", "./", "outside api/src")))


def module_statements(path, source):
    """[{'form', 'imported', 'local', 'module', 'type', 'at'}] of every import and export statement of the code.

    form: 'named' ({ a as b } of an import), 'export' ({ a as b } of an export list; module None without 'from'),
    'namespace', 'default', 'equals' (import x = require('m') or = A.B), 'star' (export * [as x] from 'm') and 'bare'
    (import 'm', which binds nothing but runs the module: source_contract lists it like any other, S5-U1c-F06). 'local'
    is the name bound or exported and 'at' its offset. import() and import.meta are module_loads' to read; an export
    declaration binds a name the occurrence check of own_import reads. A shape this reader does not know raises: a
    binding it cannot read is refused, not skipped (S5-U1c-F04).
    """
    found = []

    def fail(at, why):
        raise AssertionError(f"{path.name}: an import or export statement the binding check does not read ({why}): "
                             f"{source[at:at + 60]!r}")

    def module(index):
        kind, text, start, end = next_token(source, index)
        if kind != "string" or "\\" in text:
            fail(start, "a module that is not a plain string")
        return module_key(path, text), end

    def specifiers(index):
        """[(left, right, right_at, type)] of '{ a, type b, c as d }' from just past '{', and the offset past '}'."""
        specs = []
        while True:
            kind, text, start, end = next_token(source, index)
            if (kind, text) == ("punct", "}"):
                return specs, end
            modifier = False
            if (kind, text) == ("name", "type"):
                following = next_token(source, end)
                if following[0] == "string" or following[0] == "name" and following[1] != "as":
                    modifier, (kind, text, start, end) = True, following
            if kind != "name":
                fail(start, "a specifier that is not a name")
            left, right, right_at = text, text, start
            kind, text, start, end = next_token(source, end)
            if (kind, text) == ("name", "as"):
                kind, text, start, end = next_token(source, end)
                if kind != "name":
                    fail(start, "an 'as' without a name")
                right, right_at = text, start
                kind, text, start, end = next_token(source, end)
            specs.append((left, right, right_at, modifier))
            if (kind, text) == ("punct", "}"):
                return specs, end
            if (kind, text) != ("punct", ","):
                fail(start, "a specifier list that does not go on")
            index = end

    for keyword in STATEMENT_KEYWORD.finditer(code_mask(source)):
        word, at = keyword.group(1), keyword.start()
        kind, text, start, end = next_token(source, keyword.end())
        if word == "import" and (kind, text) in (("punct", "("), ("punct", ".")):
            continue
        type_only = False
        if (kind, text) == ("name", "type"):
            following = next_token(source, end)
            if following[0] == "punct" and following[1] in "{*" or word == "import" and following[0] == "name" \
                    and following[1] != "from":
                type_only, (kind, text, start, end) = True, following
        if word == "export":
            if (kind, text) == ("punct", "{"):
                specs, end = specifiers(end)
                source_module = None
                if next_token(source, end)[:2] == ("name", "from"):
                    source_module, end = module(next_token(source, end)[3])
                found += [{"form": "export", "imported": left, "local": right, "module": source_module,
                           "type": type_only or modifier, "at": right_at} for left, right, right_at, modifier in specs]
            elif (kind, text) == ("punct", "*"):
                local, local_at = None, None
                kind, text, start, end = next_token(source, end)
                if (kind, text) == ("name", "as"):
                    kind, local, local_at, end = next_token(source, end)
                    if kind != "name":
                        fail(local_at, "an 'as' without a name")
                    kind, text, start, end = next_token(source, end)
                if (kind, text) != ("name", "from"):
                    fail(at, "export * without 'from'")
                star_module, end = module(end)
                found.append({"form": "star", "imported": "*", "local": local, "module": star_module, "type": type_only,
                              "at": local_at})
            continue
        if kind == "string":
            found.append({"form": "bare", "imported": None, "local": None, "module": module(start)[0], "type": False,
                          "at": None})
            continue
        bound, clause = [], kind == "name" or (kind, text) in (("punct", "*"), ("punct", "{"))
        if kind == "name":
            local, local_at = text, start
            kind, text, start, end = next_token(source, end)
            if (kind, text) == ("punct", "="):
                kind, text, start, end = next_token(source, end)
                equals_module = None
                if (kind, text) == ("name", "require") and next_token(source, end)[:2] == ("punct", "("):
                    equals_module, end = module(next_token(source, end)[3])
                    if next_token(source, end)[:2] != ("punct", ")"):
                        fail(at, "require() with more than a module")
                elif kind != "name":
                    fail(start, "import = without a name or require()")
                found.append({"form": "equals", "imported": None, "local": local, "module": equals_module,
                              "type": type_only, "at": local_at})
                continue
            bound.append(("default", "default", local, local_at, False))
            if (kind, text) == ("punct", ","):
                kind, text, start, end = next_token(source, end)
        if (kind, text) == ("punct", "*"):
            kind, text, start, end = next_token(source, end)
            local = next_token(source, end)
            if (kind, text) != ("name", "as") or local[0] != "name":
                fail(start, "* without 'as' and a name")
            bound.append(("namespace", "*", local[1], local[2], False))
            kind, text, start, end = next_token(source, local[3])
        elif (kind, text) == ("punct", "{"):
            specs, end = specifiers(end)
            bound += [("named", left, right, right_at, modifier) for left, right, right_at, modifier in specs]
            kind, text, start, end = next_token(source, end)
        if not clause or (kind, text) != ("name", "from"):
            fail(at, "an import clause without 'from'")
        import_module, end = module(end)
        found += [{"form": form, "imported": imported, "local": local, "module": import_module,
                   "type": type_only or modifier, "at": local_at} for form, imported, local, local_at, modifier in bound]
    return found


def own_import(path, code, statements, name, module, uses, properties=True):
    """Raise unless one value import binds name, by its own name, from module, and name occurs in the code only there, at
    the offsets in uses and, when properties, as a property after '.': a declaration, parameter, destructuring or second
    import of the name anywhere in the file could be the binding a use reads (S5-U1c-F04). A STRICT_NAMES name is no
    property anywhere: undecorated_names refuses 'x.Get', and the calls for SetMetadata in Public's module and for a
    name no run carries pass properties=False, since 'x.SetMetadata' is that export reached through a module object
    (S5-U1c-F05)."""
    binders = [(s["form"], s["imported"], s["module"], s["type"]) for s in statements
               if s["form"] in IMPORT_FORMS and s["local"] == name]
    if binders != [("named", name, module, False)]:
        raise AssertionError(f"{path.name}: {name} is not bound once by import {{ {name} }} from '{module}': {binders}")
    at = next(s["at"] for s in statements if s["form"] in IMPORT_FORMS and s["local"] == name)
    other = []
    for match in re.finditer(rf"(?<![\w$]){re.escape(name)}(?![\w$])", code):
        before = code[:match.start()].rstrip()
        if match.start() not in {at, *uses} and not (properties and before.endswith(".") and not before.endswith("..")):
            other.append(code[max(0, match.start() - 24):match.end() + 24].strip())
    if other:
        raise AssertionError(f"{path.name}: {name} is declared or used outside its import and its uses: {other}")


def line_of(code, at):
    return code.count("\n", 0, at) + 1


def words(pattern, code):
    """pattern's matches that no identifier character precedes. The check sits here, not in a leading lookbehind, so the
    regex engine skips ahead to a name's first letter instead of trying every offset; a match that starts inside a
    longer identifier holds only identifier characters, so it hides no match that starts a word."""
    return [match for match in pattern.finditer(code)
            if not (match.start() and IDENTIFIER_CHAR.match(code, match.start() - 1))]


def undecorated_names(path, source, code, statements, uses):
    """The STRICT_NAMES the code names; raises when one occurs anywhere but the local name of an import and a decorator
    the runs read (uses), a property after '.' included (S5-U1c-F05). Public's module declares Public and calls
    SetMetadata once; public_export, which controller_inventory always runs, holds both there to exactly that."""
    exempt = {"Public", METADATA_WRITER} if path == PUBLIC_MODULE else set()
    imported = {s["at"] for s in statements if s["form"] in IMPORT_FORMS}
    present, loose = set(), []
    for match in words(STRICT_NAME, code):
        name, at = match.group(0), match.start()
        if name in exempt:
            continue
        present.add(name)
        if at not in imported and at not in uses.get(name, ()):
            loose.append((name, line_of(code, at), " ".join(source[max(0, at - 24):match.end() + 32].split())))
    if loose:
        names = ", ".join(sorted({name for name, _line, _text in loose}))
        raise AssertionError(f"{path.name}: {names} used where no decorator the inventory reads applies it: "
                             f"{[(line, text) for _name, line, text in loose]}")
    return present


def gathered(problems, step, *args):
    """step(*args), or None with its refusal added to problems: every check runs, so a refusal names each of its reasons
    and a regression can assert the one it is about even where another check refuses the same text too (S5-U1c-F06)."""
    try:
        return step(*args)
    except AssertionError as error:
        problems.append(str(error))
        return None


def bracket_end(code, at):
    """Offset just past the bracket that closes code[at], one of '(', '[' and '{'; code is masked, so each is code."""
    opener = code[at]
    closer, depth = {"(": ")", "[": "]", "{": "}"}[opener], 0
    for index in range(at, len(code)):
        if code[index] == opener:
            depth += 1
        elif code[index] == closer:
            depth -= 1
            if depth == 0:
                return index + 1
    raise AssertionError(f"unbalanced {opener!r} at offset {at}")


def before_token(code, at):
    """(text, offset) of the token that ends before code[at] past whitespace: a whole word or one character; ('', -1) at
    the start of the code."""
    back = at - 1
    while back >= 0 and code[back].isspace():
        back -= 1
    if back < 0:
        return "", -1
    if not IDENTIFIER_CHAR.match(code[back]):
        return code[back], back
    start = back
    while start > 0 and IDENTIFIER_CHAR.match(code[start - 1]):
        start -= 1
    return code[start:back + 1], start


def is_property(code, at):
    """Whether the name at code[at] follows '.' or '?.': a member of something, not a binding ('...' is a spread)."""
    token, index = before_token(code, at)
    return token == "." and not (index > 0 and code[index - 1] == ".")


def owner(code, at):
    """(name, offset) of the name before the '.' in front of code[at], or None: after '?.', a call or an index there is
    no name to read."""
    token, index = before_token(code, at)
    if token != "." or (index > 0 and code[index - 1] in ".?"):
        return None
    name, start = before_token(code, index)
    return (name, start) if KEY_NAME.fullmatch(name) else None


def this_field(code, at):
    """Whether the member at code[at] is this.<name> or this.<field>.<name>, and this itself no property."""
    base = owner(code, at)
    if base is not None and base[0] != "this":
        base = owner(code, base[1])
    return base is not None and base[0] == "this" and not is_property(code, base[1])


def enclosing(code, at):
    """Offset of the innermost bracket open at code[at], or None at the top level."""
    depth = 0
    for index in range(at - 1, -1, -1):
        if code[index] in ")]}":
            depth += 1
        elif code[index] in "([{":
            if depth == 0:
                return index
            depth -= 1
    return None


def heading_token(code, index):
    """(text, start, end) of the token at code[index] past whitespace: a name or number, '=>' or one character; ('',
    end, end) at the end. code is masked, so no comment or literal is left to read."""
    while index < len(code) and (code[index] in WHITESPACE or code[index].isspace()):
        index += 1
    word = IDENTIFIER.match(code, index)
    end = word.end() if word else min(len(code), index + (2 if code.startswith("=>", index) else 1))
    return code[index:end], index, end


def angle_end(code, at):
    """Offset past the '>' that closes the '<' at code[at] of type parameters or type arguments: '<' and '>' counted,
    '(', '[' and '{' skipped whole to the bracket that closes them (a type literal, a function type's parameters, a
    tuple), '=>' an arrow. A '<' that does not close raises, and so does a token no type is written with, so the reader
    neither stops at a type literal's '{' nor reads on past the heading (S5-U1c-F08)."""
    depth, index = 0, at
    while True:
        text, start, end = heading_token(code, index)
        if not text:
            raise AssertionError(f"the '<' at offset {at} does not close")
        if text == "<":
            depth += 1
        elif text == ">":
            depth -= 1
            if depth == 0:
                return end
        elif text in ("(", "[", "{"):
            end = bracket_end(code, start)
        elif not (IDENTIFIER.fullmatch(text) or text == "=>" or text in TYPE_PUNCT):
            raise AssertionError(f"{text!r} at offset {start} inside the '<' at offset {at}, which no type is written with")
        index = end


def reference_end(code, index, clause):
    """Offset past one class reference of an extends or implements clause at code[index]: a name, then '.' and a name
    and type arguments; after extends also a parenthesised start, call arguments and an index ('extends
    Mixin(Base)<T>'). A keyword where the name goes, and any other start, raises."""
    text, start, end = heading_token(code, index)
    if clause == "extends" and text == "(":
        end = bracket_end(code, start)
    elif not KEY_NAME.fullmatch(text) or text in OPERAND_WORDS | UNREAD_WORDS:
        raise AssertionError(f"{text!r} at offset {start}, where the {clause} clause names a class")
    while True:
        text, start, following = heading_token(code, end)
        if text == ".":
            text, start, following = heading_token(code, following)
            if not IDENTIFIER.fullmatch(text):
                raise AssertionError(f"{text!r} at offset {start} after '.' in the {clause} clause")
        elif text == "<":
            following = angle_end(code, start)
        elif clause == "extends" and text in ("(", "["):
            following = bracket_end(code, start)
        else:
            return end
        end = following


def class_heading(code, at):
    """{'body', 'extends'} of the class keyword at code[at]: the offset of the '{' that opens its class body, and the
    offsets of the extends that open its heritage clauses. code is masked.

    The heading is read as TypeScript writes one: 'class', a name unless the class is an expression or a default
    export, type parameters, extends and implements clauses in either order (the reader does not rely on the order the
    compiler asks for), then the '{' of the body. Type parameters and arguments are read to their closing '>'
    (angle_end). The reader before this took the first '{' after 'class' for the body, so the type literal of '<T =
    {}>', '<T = { marker: string }>' or '<T = () => { marker: string }>' ended the heading before the 'extends
    PacsController' after it: a registered controller that would serve GET unlisted/health, PacsController's @Public(),
    left both inventories at 110 rows and public 4 (S5-U1c-F08). Anything else after 'class' raises with its reason:
    the reader does not guess where such a heading ends.
    """
    text, start, end = heading_token(code, at + len("class"))
    if KEY_NAME.fullmatch(text) and text not in HERITAGE_WORDS:
        text, start, end = heading_token(code, end)
    if text == "<":
        text, start, end = heading_token(code, angle_end(code, start))
    extends = []
    while text in HERITAGE_WORDS:
        clause = text
        if clause == "extends":
            extends.append(start)
        text, start, end = heading_token(code, reference_end(code, end, clause))
        while clause == "implements" and text == ",":
            text, start, end = heading_token(code, reference_end(code, end, clause))
    if text != "{":
        raise AssertionError(f"{text!r} at offset {start}, where the class heading goes on or its body opens")
    return {"body": start, "extends": tuple(extends)}


def class_keywords(code):
    """Offsets of the class keywords of code; 'class' after '.', '?.' or '#' is a property name, not a keyword."""
    return [match.start() for match in CLASS_WORD.finditer(code)
            if not (is_property(code, match.start()) or before_token(code, match.start())[0] == "#")]


@functools.lru_cache(maxsize=None)
def class_bodies(code):
    """The offsets of every '{' that opens a class body in code: one per class keyword whose heading class_heading
    reads. A keyword it does not read opens none, so a require in that block is read as a call, which can only refuse."""
    bodies = set()
    for at in class_keywords(code):
        try:
            bodies.add(class_heading(code, at)["body"])
        except AssertionError:
            continue
    return frozenset(bodies)


def class_body(code, brace):
    """Whether the '{' at code[brace] opens a class body, as class_heading reads the class keyword's heading. The reader
    before this took a '{' whose text since the ';', '{' or '}' before it held the word class, so 'if (x. class) {'
    passed a loader call in that block, with a block after it, as a method declaration, and the body of 'class
    Access<T = { marker: string }> {' was none (S5-U1c-F08)."""
    return brace in class_bodies(code)


def class_method(code, at, end):
    """Whether the require at code[at], its parameter list ending before code[end], declares a method: the innermost
    open bracket is a class body, the end of the previous member or a modifier stands before it, and '{' or a return
    type follows. 'true ? require(name) : null' has '?' before it, and 'require(name)' with a block on the next line
    stands in a function body: both are calls, which the ':' or '{' after them passed as declarations (S5-U1c-F06)."""
    opener = enclosing(code, at)
    return (opener is not None and code[opener] == "{" and class_body(code, opener)
            and before_token(code, at)[0] in MEMBER_START and code.startswith(("{", ":"), skip_gap(code, end)))


def loader_argument(source, paren, end):
    """('plain', text) when one '...' or "..." literal without an escape is all that stands between source[paren] and
    the ')' before source[end]; ('template', text) for one such template without substitutions; (None, None) for
    anything else, which a loader call computes."""
    start = skip_gap(source, paren + 1)
    if start >= end - 1 or source[start] not in "'\"`":
        return None, None
    if source[start] == "`":
        stop, opened = template_part(source, start + 1)
        kind = None if opened else "template"
    else:
        stop, kind = literal_end(source, start), "plain"
    text = source[start + 1:stop - 1]
    if kind is None or "\\" in text or skip_gap(source, stop) != end - 1:
        return None, None
    return kind, text


def string_value(text):
    """The value of a string literal's text: its escapes decoded and a line continuation dropped."""
    def decode(match):
        digits = match.group(1) or match.group(2) or match.group(3)
        if digits:
            point = int(digits, 16)
            return chr(point) if point <= 0x10FFFF else "�"
        char = match.group(4)
        return "" if char == "\r\n" or char in LINE_TERMINATORS else SIMPLE_ESCAPES.get(char, char)
    return STRING_ESCAPE.sub(decode, text)


def array_literal(code, bracket):
    """Whether the '[' at code[bracket] opens an array literal: no name, ')' or ']' (an index) and no '.' ('?.[' an
    index, '...[' a spread into a call's arguments) stands before it."""
    token, _index = before_token(code, bracket)
    return not (token in (")", "]", ".") or KEY_NAME.fullmatch(token) and token not in REGEX_WORDS)


@functools.lru_cache(maxsize=None)
def literal_keys(source):
    """(text, escaped, handles): code_mask(source) with each string literal, or template without substitutions, that
    stands alone between '[' and ']' written in place as '.' and the name it spells ('?.[' as '?.' and the name), the
    keys of that kind holding an escape, and the literals anywhere but in an array literal whose value is a
    STRING_HANDLES name."""
    code, strings, _regexes = lexed(source)
    out, escaped, handles = list(code), [], []
    for match in re.finditer(r"\[", code):
        at = match.start()
        start = skip_gap(source, at + 1)
        if start >= len(source) or source[start] not in "'\"`":
            continue
        if source[start] == "`":
            stop, opened = template_part(source, start + 1)
            if opened:
                continue
        else:
            stop = literal_end(source, start)
        close = skip_gap(source, stop)
        if not source.startswith("]", close):
            continue
        key = source[start + 1:stop - 1]
        if "\\" in key:
            escaped.append((line_of(code, at), key))
        elif KEY_NAME.fullmatch(key):
            token, index = before_token(code, at)
            out[at:close + 1] = [char if char in LINE_TERMINATORS else " " for char in code[at:close + 1]]
            out[at] = " " if token == "." and index > 0 and code[index - 1] == "?" else "."
            out[start + 1:stop - 1] = key
    for start, stop in strings:
        value = string_value(source[start + 1:stop - 1])
        if value not in STRING_HANDLES:
            continue
        opener = enclosing(code, start)
        if not (opener is not None and code[opener] == "[" and array_literal(code, opener)):
            handles.append((line_of(code, start), value))
    return "".join(out), tuple(escaped), tuple(handles)


def property_names(path, source):
    """code_mask(source) with x['name'] read as x.name, so the name checks see a member a literal key reaches: blanked
    as strings, module['require'] and common['Put'] passed every check (S5-U1c-F06). An array of one string reads the
    same way, which can only refuse more. Refused: a key holding an escape, and a string that spells a STRING_HANDLES
    name anywhere but in an array literal, which a reflective call or a quoted member name would read as that name. A
    key that is an expression is not read (source_contract.outside_the_contract)."""
    text, escaped, handles = literal_keys(source)
    problems = []
    if escaped:
        problems.append(f"{path.name}: an escaped property key, which the name checks do not read: {list(escaped)}")
    if handles:
        problems.append(f"{path.name}: a string literal that spells a handle source_contract seals, outside an array "
                        f"literal: {list(handles)}")
    if problems:
        raise AssertionError(" | ".join(problems))
    return text


def metadata_writes(path, code, named):
    """Raise on a metadata writer: defineMetadata, decorate or createDecorator under any object or literal key, and
    Reflect other than 'Reflect.<member>' of a member source_contract lists (S5-U1c-F05/F06). named is the
    property_names text; the member after Reflect is read from code, where a literal key is still blank, so
    Reflect['x'] is Reflect handed on."""
    found = [(line_of(named, match.start()), match.group(0)) for match in words(WRITER_NAME, named)]
    for match in words(REFLECT_NAME, named):
        dot = skip_gap(code, match.end())
        member = IDENTIFIER.match(code, skip_gap(code, dot + 1)) if code.startswith(".", dot) else None
        if member is None or member.group(0) not in REFLECT_MEMBERS:
            found.append((line_of(named, match.start()), "Reflect" + ("." + member.group(0) if member else "")))
    if found:
        raise AssertionError(f"{path.name}: a metadata writer that attaches route or public metadata without a decorator "
                             f"the inventory reads: {sorted(found)}")


def regex_names(path, source):
    """Raise on a regex literal whose text spells a name the name checks read (S5-U1c-F07). The lexer blanks a regex
    literal, so a '/' read as one where TypeScript divides hides everything up to the next '/' from those checks, as
    'probe++ / (() => { ... Reflect.defineMetadata(...) ... })() / 1' did; no regex of api/src spells one."""
    found = sorted({(line_of(source, start), match.group(0)) for start, end in lexed(source)[2]
                    for pattern in CHECKED_NAMES for match in words(pattern, source[start:end])})
    if found:
        raise AssertionError(f"{path.name}: a regex literal that spells a name the source checks read, which a '/' read "
                             f"as a regex where TypeScript divides would hide from them: {found}")


def module_loads(path, source, code):
    """[package] of the loader calls source_contract supports; raises on every other require or import (S5-U1c-F05/F06).

    import is a statement keyword, which module_statements reads, or 'import(...)'. require is 'require(...)', a method
    declared in a class body, or this.require(...) and this.<field>.require(...), how the services call StudyAccess. A
    loader call is the bare callee with one plain string literal naming a loaded package and nothing else: the reader
    before this took 'require('@nest' + 'js/common')' by its first string, 'true ? require(name) : null' by the ':'
    after the call as a method's return type, 'module.require(name)' as a method call, and module['require'] was a
    string, so each loaded Nest's common unread (S5-U1c-F06). code is the property_names text, where module['require']
    is module.require; 'import x = require('m')' is a loader call too.
    """
    found, loaded = [], []
    for match in words(LOADER_NAME, code):
        word, at = match.group(1), match.start()
        paren = skip_gap(code, match.end())
        called = code.startswith("(", paren)
        end = call_end(code, paren) if called else paren
        text = word + ("(" + " ".join(source[paren + 1:end - 1].split()) + ")" if called else "")
        if is_property(code, at):
            if not (word == "require" and called and this_field(code, at)):
                base = owner(code, at)
                found.append((line_of(code, at), f"{base[0] if base else '<expression>'}.{text}: a member {word} other "
                                                 f"than this.require(...) or this.<field>.require(...)"))
            continue
        if not called:
            if word == "require" or code.startswith(".", paren):
                found.append((line_of(code, at), "require not called" if word == "require" else "import.meta"))
            continue
        if word == "require" and class_method(code, at, end):
            continue
        kind, module = loader_argument(source, paren, end)
        if kind == "plain" and module in LOADED_PACKAGES:
            loaded.append(module)
        elif kind == "plain":
            found.append((line_of(code, at), f"{word}({module!r}): not a package the loaders may take"))
        elif kind == "template":
            found.append((line_of(code, at), f"{word}({module!r}) written as a template, not one plain string literal"))
        else:
            found.append((line_of(code, at), f"{word}() of a module computed at run time or written other than as one "
                                             f"plain string literal: {text}"))
    if found:
        raise AssertionError(f"{path.name}: a module loader the binding check does not follow (source_contract: the "
                             f"bare callee and one plain string literal naming a loaded package): {found}")
    return loaded


def contract_names(path, code):
    """Raise on a sealed word anywhere and on Object, Array, process, prototype, getPrototypeOf and constructor outside
    the forms source_contract lists (S5-U1c-F06); code is the property_names text.

    Nest serves every route method on the prototype chain of the instance it builds for a registered class, under that
    class's @Controller() prefix. So no code reaches a class prototype (Object.assign, defineProperty or setPrototypeOf
    onto X.prototype or Object.getPrototypeOf(this)), no constructor returns another object, Object and Array are not
    rebound (which would let 'Object.prototype' name a class), and nothing builds a Function (eval, Function, a
    constructor reached as a property) or reaches a loader through process or module: each would put route methods
    read under one file's prefix on an instance served under another's, or load a module unread.
    """
    found = [(line_of(code, match.start()), match.group(0)) for match in words(SEALED_WORD, code)]

    def add(match, text):
        found.append((line_of(code, match.start()), text))

    for match in words(OWNER_NAME, code):
        after, keyword = skip_gap(code, match.end()), before_token(code, match.start())[0]
        if is_property(code, match.start()):
            continue
        used = code.startswith((".", "<"), after) or keyword == "new" and code.startswith("(", after)
        if keyword in DECLARING or not used:
            add(match, f"{match.group(0)} other than {match.group(0)}.<member>")
    for match in words(PROCESS_NAME, code):
        dot = skip_gap(code, match.end())
        member = IDENTIFIER.match(code, skip_gap(code, dot + 1)) if code.startswith(".", dot) else None
        if not is_property(code, match.start()) and (member is None or member.group(0) not in PROCESS_MEMBERS):
            add(match, "process" + ("." + member.group(0) if member else ""))
    for match in words(PROTOTYPE_NAME, code):
        base = owner(code, match.start())
        if base is None or base[0] not in PROTOTYPE_OWNERS or is_property(code, base[1]):
            add(match, (base[0] + "." if base else "") + "prototype")
    for match in words(GET_PROTOTYPE_NAME, code):
        base, paren = owner(code, match.start()), skip_gap(code, match.end())
        compared = code.startswith("(", paren) and code.startswith(("===", "!=="), skip_gap(code, call_end(code, paren)))
        if not (base is not None and base[0] == "Object" and not is_property(code, base[1]) and compared):
            add(match, "getPrototypeOf other than compared by === or !==")
    for match in words(CONSTRUCTOR_NAME, code):
        paren = skip_gap(code, match.end())
        body = skip_gap(code, call_end(code, paren)) if code.startswith("(", paren) else paren
        if is_property(code, match.start()):
            add(match, "constructor as a property")
        elif not code.startswith("(", paren) or not code.startswith("{", body):
            add(match, "constructor other than a declaration")
        elif RETURN_WORD.search(code, body, bracket_end(code, body)):
            add(match, "return in a constructor")
    if found:
        raise AssertionError(f"{path.name}: a sealed name or a form the source contract does not list: {sorted(found)}")


def module_sources(path, statements):
    """Raise on a module statement naming a package source_contract does not list, or a relative module outside api/src
    (S5-U1c-F06): node:module hands out createRequire, node:vm evaluates code, and a file outside api/src would be
    compiled into the app without either inventory reading it."""
    unlisted = sorted({s["module"] for s in statements
                       if s["module"] is not None and not s["module"].startswith("./") and s["module"] not in PACKAGES})
    if unlisted:
        raise AssertionError(f"{path.name}: a module the source contract does not list (source_contract.packages, or a "
                             f"file under api/src): {unlisted}")


def controller_heritage(path, code):
    """Raise on a class with an extends clause in a *.controller.ts file (S5-U1c-F06): its instances would carry the
    base's route methods, read under the base's file and served under this file's @Controller() prefix.

    Every class keyword's heading is read to the '{' of its body by class_heading, past type parameters and heritage
    clauses (S5-U1c-F08). An extends that opens a heritage clause is refused; an extends anywhere else in the heading, a
    type parameter constraint or a conditional type, is a form source_contract does not list; and a class keyword whose
    heading class_heading does not read (a '<' that does not close, a token no heading holds, class as a key or a member
    name) is refused too, since an extends in what follows it would go unread. Each kind is its own reason."""
    heritage, elsewhere, unread = [], [], []
    for at in class_keywords(code):
        try:
            heading = class_heading(code, at)
        except AssertionError as error:
            unread.append((line_of(code, at), str(error), " ".join(code[at:at + 60].split())))
            continue
        text = " ".join(code[at:heading["body"]].split())
        if heading["extends"]:
            heritage.append((line_of(code, at), text))
        elif EXTENDS_WORD.search(code, at, heading["body"]):
            elsewhere.append((line_of(code, at), text))
    problems = []
    if heritage:
        problems.append(f"{path.name}: a class in a controller file extends another class, whose route methods it would "
                        f"serve under this file's prefix: {heritage}")
    if elsewhere:
        problems.append(f"{path.name}: a class heading in a controller file holds extends outside a heritage clause (a "
                        f"type parameter constraint or a conditional type), which source_contract does not list: "
                        f"{elsewhere}")
    if unread:
        problems.append(f"{path.name}: a class keyword in a controller file whose heading the reader does not read to "
                        f"its body, so an extends in it could go unread: {unread}")
    if problems:
        raise AssertionError(" | ".join(problems))


def decorator_bindings(path, source, runs):
    """{name: module} of the decorator names the runs read; raises unless each is its module's own export (S5-U1c-F04)
    and nothing applies a route, a controller or public metadata another way (S5-U1c-F05).

    The inventories classify by name, and 'import { Get as Header }' plus 'import { Public as HttpCode } from
    './auth.guard'' made '@HttpCode() @Header('x')' a public route both read as a header and a status code. So, in every
    api/src file: no identifier is escaped in code (the occurrence check reads names as written), no import or export
    renames a BOUND_NAMES name from or to another, no namespace, default, import = or export * takes a module that
    exports decorators or binds a BOUND_NAMES name, and every name the runs read passes own_import against
    DECORATOR_MODULE with its decorators as the uses.

    The runs alone name what is checked, so 'import { Put }' and 'Put('unlisted')(target, 'unlisted', descriptor)' after
    the class made a public route both inventories missed. Then, also in every file: a STRICT_NAMES name occurs only as
    its import and its decorators (undecorated_names) and is bound by its own import from STRICT_MODULE even when no
    decorator uses it, no metadata writer occurs (metadata_writes), and no loader reaches a project file or a Nest
    package (module_loads).

    S5-U1c-F06: those name checks read the property_names text, so a literal key (common['Put'], module['require']) is
    the member it names, and source_contract closes the rest: loader calls (module_loads), sealed words and the listed
    forms of Object, Array, process, prototype, getPrototypeOf and constructor (contract_names), the modules a statement
    may name (module_sources) and no namespace, default, import = or export * of a project file or a Nest package. Each
    of these checks runs and the refusal joins their reasons.
    """
    code = code_mask(source)
    if "\\" in code:
        raise AssertionError(f"{path.name}: an escaped identifier in code, which the binding check does not read")
    statements = module_statements(path, source)
    renamed = sorted({(s["imported"], s["local"]) for s in statements if s["form"] in ("named", "export")
                      and s["imported"] != s["local"] and BOUND_NAMES.intersection((s["imported"], s["local"]))})
    if renamed:
        raise AssertionError(f"{path.name}: an import or export renames a decorator name: {renamed}")
    whole = sorted((s["form"], s["module"], s["local"]) for s in statements if s["form"] in ("namespace", "default",
                   "equals", "star") and (whole_module(s["module"]) or s["local"] in BOUND_NAMES))
    if whole:
        raise AssertionError(f"{path.name}: a whole-module binding of a module that exports decorators, a project file "
                             f"or a Nest package, or under a decorator name: {whole}")
    uses = {}
    for run in runs:
        for name, start, _end in run["items"]:
            uses.setdefault(name, set()).add(DECORATOR_CALL.match(code, start).start(1))
    problems = []
    gathered(problems, property_names, path, source)
    named = literal_keys(source)[0]
    for name, offsets in sorted(uses.items()):
        gathered(problems, own_import, path, named, statements, name, DECORATOR_MODULE.get(name), offsets)
    present = gathered(problems, undecorated_names, path, source, named, statements, uses)
    gathered(problems, metadata_writes, path, code, named)
    gathered(problems, regex_names, path, source)
    gathered(problems, module_loads, path, source, named)
    gathered(problems, contract_names, path, named)
    gathered(problems, module_sources, path, statements)
    for name in sorted((present or set()) - set(uses)):
        gathered(problems, own_import, path, named, statements, name, STRICT_MODULE[name], set(), False)
    if problems:
        raise AssertionError(" | ".join(problems))
    return {name: DECORATOR_MODULE[name] for name in sorted(uses)}


def public_export(sources):
    """The Public binding ends in its module: './auth.guard' declares Public once, in code, as the public-metadata call
    test_05 counts, of Nest's own SetMetadata, and names Public nowhere else (S5-U1c-F04); SetMetadata occurs there
    only as its import and in that declaration, not as a property either (S5-U1c-F05)."""
    path = PUBLIC_MODULE
    if path not in sources:
        raise AssertionError(f"{path.name}, the module every Public import names, is not among the sources")
    source, declaration = sources[path], BINDINGS["public_declaration"]
    code, at = code_mask(source), source.find(declaration)
    head = declaration[:declaration.index("Public") + len("Public")]
    if source.count(declaration) != 1 or code[at:at + len(head)] != head:
        raise AssertionError(f"{path.name}: Public is not declared once, in code, as {declaration!r}")
    named = at + len(head) - len("Public")
    elsewhere = [m.start() for m in re.finditer(r"(?<![\w$])Public(?![\w$])", code) if m.start() != named]
    if elsewhere:
        raise AssertionError(f"{path.name}: Public occurs outside its declaration at offsets {elsewhere}")
    metadata = BINDINGS["public_metadata_import"]
    own_import(path, code, module_statements(path, source), metadata["name"], metadata["module"],
               {at + declaration.index(metadata["name"])}, properties=False)


def outside_decorators(path, source):
    """Decorator names of an api/src file that is not *.controller.ts, read by the lexer and runs a controller gets.

    Both inventories open *.controller.ts only, so a route decorator, @Controller(), @RequestMapping() or @Public()
    anywhere else declares what neither sees (S5-U1c-F03). It is refused, and so are a shape the runs cannot read, a
    name outside_decorators does not classify (an alias or a wrapper can make a route), such call text in a comment
    or literal, a classified name that is not Nest's own export ('Controller as Injectable', S5-U1c-F04), a route,
    Controller or Public applied by a call, a metadata writer or a loader ('Controller('x')(Unlisted)', S5-U1c-F05) and
    any form source_contract does not list (S5-U1c-F06).
    """
    runs = decorator_runs(source)
    names = [name for run in runs for name, _start, _end in run["items"]]
    misplaced = sorted(DECIDING.intersection(names))
    if misplaced:
        raise AssertionError(f"{path.name}: {misplaced} outside *.controller.ts, a file neither inventory reads")
    unknown = sorted(set(names) - OUTSIDE_DECORATORS)
    if unknown:
        raise AssertionError(f"{path.name}: decorators outside the controllers that outside_decorators does not "
                             f"classify: {unknown}")
    text = decorator_text(source)
    if text:
        raise AssertionError(f"{path.name}: route, @Controller() or @Public() call text outside *.controller.ts {text}")
    decorator_bindings(path, source, runs)
    return names


def controller_handlers(path, source):
    """[(method, child path, public, offset)] per handler; raises on a decorator shape the inventory could misread."""
    handlers = []
    for run in decorator_runs(source):
        names = [name for name, _start, _end in run["items"]]
        routes = [item for item in run["items"] if item[0] in HTTP_DECORATORS]
        publics = [index for index, name in enumerate(names) if name == "Public"]
        unknown = sorted(set(names) - KNOWN_DECORATORS)
        if unknown:
            raise AssertionError(f"{path.name}: decorators the inventory neither reads nor classifies: {unknown}")
        if run["kind"] != "member":
            if routes or publics:
                raise AssertionError(f"{path.name}: route or @Public() decorator on a {run['kind']}: {names}")
            continue
        if not routes:
            if publics:
                raise AssertionError(f"{path.name}: @Public() on a member without a route decorator: {names}")
            continue
        if len(routes) != 1 or len(publics) > 1:
            raise AssertionError(f"{path.name}: one handler carries {names}")
        name, start, end = routes[0]
        parsed = ROUTE_TEXT.fullmatch(source, start, end)
        if parsed is None:
            raise AssertionError(f"{path.name}: unreadable route decorator {source[start:end]!r}")
        # the order the four public handlers use; Nest would accept either, the pin keeps one reading of the file
        if publics and publics[0] > names.index(name):
            raise AssertionError(f"{path.name}: @Public() must sit above its route decorator: {names}")
        handlers.append((HTTP_DECORATORS[name], (parsed.group(3) or "").strip("/"), bool(publics), start))
    return handlers


def previous_public_attribution(source):
    """S5-U1a's reading, kept only as the D5 control: a @Public() between two route decorators went to the later one."""
    out, previous = {}, 0
    for match in re.finditer(rf"@({ROUTE_NAMES})\(\s*(?:(['\"])(.*?)\2)?\s*\)", source):
        out[match.group(3) or ""] = "@Public()" in source[previous:match.start()]
        previous = match.end()
    return out


def api_sources(root=API):
    """{path: text} of every .ts file under api/src; raises when api/src holds a script of a kind no inventory opens."""
    files = sorted(path for path in root.rglob("*") if path.is_file())
    unread = [path.relative_to(root).as_posix() for path in files if path.suffix in UNREAD_SCRIPTS]
    if unread:
        raise AssertionError(f"scripts under api/src that neither inventory opens: {unread}")
    return {path: path.read_text(encoding="utf-8") for path in files if path.suffix == ".ts"}


def controller_routes(path, source, runs):
    """[((method, route), public)] of one *.controller.ts file; raises when a decorator shape cannot be read."""
    controllers = [(run["kind"], start, end) for run in runs for name, start, end in run["items"]
                   if name == "Controller"]
    if [kind for kind, _start, _end in controllers] != ["class"]:
        raise AssertionError(f"{path.name}: expected one @Controller() on a class, found {controllers}")
    readable = CONTROLLER_TEXT.fullmatch(source, *controllers[0][1:])
    if readable is None:
        raise AssertionError(f"{path.name}: unreadable {source[slice(*controllers[0][1:])]!r}")
    prefix = (readable.group(2) or "").strip("/")
    handlers = controller_handlers(path, source)
    # every route item became a handler or controller_handlers raised, so the read items are the whole decision
    read = {start for run in runs for _name, start, _end in run["items"]}
    stray = [text for offset, text in decorator_text(source) if offset not in read]
    if stray:
        raise AssertionError(f"{path.name}: decorator call text the inventory did not read (comments and literals "
                             f"count too) {stray}")
    return [((method, "/".join(part for part in (prefix, child) if part)), public)
            for method, child, public, _offset in handlers]


def controller_inventory(sources=None):
    """(method, route) -> {'file', 'public'}; raises when a decorator shape cannot be read.

    sources ({path: text}, default every .ts file under api/src) lets a test judge an edited or added file without
    writing it. A file that is not *.controller.ts must pass outside_decorators, so a route declared there stops the
    inventory, and with it test_05, instead of being left out (S5-U1c-F03). Every decorator name a controller carries
    must be its module's own export and Public must end at its declaration, or a route or @Public() under a classified
    name stops it too (S5-U1c-F04), and so does a route or Public applied by a call, a metadata writer or a loader in
    any file (S5-U1c-F05), any form source_contract does not list and an extends clause in a controller file
    (S5-U1c-F06), read past the generic defaults whose type literal hid it (S5-U1c-F08). Every check runs on every file
    and the refusal joins each reason.
    """
    found, problems = {}, []
    sources = api_sources() if sources is None else sources
    for path, source in sorted(sources.items()):
        if path.suffix != ".ts":
            problems.append(f"{path.name}: a script neither inventory opens")
            continue
        if not path.name.endswith(".controller.ts"):
            gathered(problems, outside_decorators, path, source)
            continue
        runs = gathered(problems, decorator_runs, source)
        if runs is None:
            continue
        for key, public in gathered(problems, controller_routes, path, source, runs) or []:
            if key in found:
                problems.append(f"duplicate route {key}")
            found[key] = {"file": path.name, "public": public}
        gathered(problems, decorator_bindings, path, source, runs)
        gathered(problems, controller_heritage, path, code_mask(source))
    gathered(problems, public_export, sources)
    if problems:
        raise AssertionError(" | ".join(problems))
    return found


HTTP_CODE_TEXT = re.compile(r"@\s*HttpCode\s*\(\s*([1-5][0-9]{2})\s*\)")


def handler_statuses(sources=None):
    """S5-U4a: 'METHOD route' -> the success status the handler declares, @HttpCode(n) or else Nest's default (201 for
    POST, 200 for every other method). test_14 reads an allow row that answers 201 as a write row, so a new writing
    route cannot join the matrix under the read contract. The runs are the inventory's; test_14 runs the inventory
    first and compares the keys. Two @HttpCode() on a handler, or one that is not a literal status, is refused."""
    out = {}
    for path, source in sorted((api_sources() if sources is None else sources).items()):
        if not path.name.endswith(".controller.ts"):
            continue
        runs = decorator_runs(source)
        [prefix] = [(CONTROLLER_TEXT.fullmatch(source, start, end).group(2) or "").strip("/")
                    for run in runs for name, start, end in run["items"] if name == "Controller"]
        for run in runs:
            routes = [item for item in run["items"] if item[0] in HTTP_DECORATORS]
            if run["kind"] != "member" or not routes:
                continue
            if len(routes) != 1:
                raise AssertionError(f"{path.name}: one handler carries {[name for name, _s, _e in run['items']]}")
            name, start, end = routes[0]
            codes = [source[at:to] for item, at, to in run["items"] if item == "HttpCode"]
            read = [HTTP_CODE_TEXT.fullmatch(text) for text in codes]
            if len(read) > 1 or None in read:
                raise AssertionError(f"{path.name}: a status the reader does not read on {source[start:end]}: {codes}")
            method = HTTP_DECORATORS[name]
            child = (ROUTE_TEXT.fullmatch(source, start, end).group(3) or "").strip("/")
            key = method + " " + "/".join(part for part in (prefix, child) if part)
            out[key] = int(read[0].group(1)) if read else 201 if method == "POST" else 200
    return out


def manifest_rows():
    """The invariants_live ROUTES keys in file order; a repeated key would be collapsed silently by the dict."""
    text = MANIFEST.read_text(encoding="utf-8")
    start = text.index("ROUTES: dict[tuple[str, str], Route] = {")
    end = text.index("\n}\n", start)
    return re.findall(r'\("([A-Z]+)", "([^"]+)"\): Route\(', text[start:end])


def manifest_routes():
    return set(manifest_rows())


def ts_array(source, name):
    match = re.search(rf"export const {re.escape(name)}\b[^=]*=\s*Object\.freeze\(\[(.*?)\]\);", source, re.S)
    if match is None:
        raise AssertionError(f"{name} is not a frozen literal array")
    return re.findall(r"'([^']*)'", match.group(1))


class ClinicianPolicySpec(unittest.TestCase):
    policy = POLICY.read_text(encoding="utf-8")
    guard = GUARD.read_text(encoding="utf-8")
    admin = ADMIN.read_text(encoding="utf-8")
    keycloak = KEYCLOAK.read_text(encoding="utf-8")

    def test_01_policy_constants_are_the_fixture_values(self):
        self.assertEqual(ts_array(self.policy, "LEGACY_APP_ROLES"), FIXTURES["legacy_roles"])
        self.assertRegex(self.policy, r"export const CLINICIAN_ROLE = 'clinician';")
        self.assertRegex(self.policy, r"export const APP_ROLES\b[^=]*=\s*new Set\(\[\.\.\.LEGACY_APP_ROLES, CLINICIAN_ROLE\]\);")
        self.assertEqual(ts_array(self.policy, "CLINICIAN_SESSION_ROUTES"), FIXTURES["session_routes"])
        self.assertEqual(ts_array(self.policy, "CLINICIAN_BUSINESS_ROUTES"), FIXTURES["business_routes"])
        # U1a shipped an empty business allowlist; U1b adds read rows only. The non-GET rows are the viewer's SOP lookup
        # (answers an Orthanc instance id, writes nothing) and the three S5-U4a question writes (decision D33: create,
        # reply, close; the service decides each action's role); anything else that is not a GET is a new decision.
        self.assertEqual(len(FIXTURES["business_routes"]), len(set(FIXTURES["business_routes"])))
        self.assertEqual([k for k in FIXTURES["business_routes"] if not k.startswith("GET ")],
                         ["POST dicom/lookup", "POST studies/:uid/questions", "POST questions/:id/entries", "POST questions/:id/close"])
        self.assertTrue({"GET authz/dicom", "POST dicom/lookup"} <= set(FIXTURES["business_routes"]),
                        "the viewer read pair is allowed together or not at all")
        self.assertTrue(set(FIXTURES["must_stay_denied"]).isdisjoint(ALLOWED))
        self.assertRegex(self.policy, r"export const CLINICIAN_ALLOWED_ROUTES\b[^=]*=\s*new Set\(\[\.\.\.CLINICIAN_SESSION_ROUTES, \.\.\.CLINICIAN_BUSINESS_ROUTES\]\);")
        self.assertRegex(self.policy, r"export const CLINICIAN_ROUTE_DENIED = 'CLINICIAN_ROUTE_DENIED';")
        self.assertEqual(FIXTURES["denied_code"], "CLINICIAN_ROUTE_DENIED")
        self.assertEqual(sorted(FIXTURES["session_routes"]), ["GET me", "POST auth/logout"])
        # fail-closed shape: unknown method or non-string paths return null, null is never allowed
        self.assertRegex(self.policy, r"if \(typeof name !== 'string' \|\| !/\^\[A-Z\]\+\$/\.test\(name\)\) return null;")
        self.assertRegex(self.policy, r"if \(prefix === null \|\| child === null\) return null;")
        self.assertRegex(self.policy, r"return key !== null && CLINICIAN_ALLOWED_ROUTES\.has\(key\);")
        self.assertRegex(self.policy, r"return app\.length > 0 && app\.every\(role => role === CLINICIAN_ROLE\);")

    def test_02_token_fixtures_against_the_model(self):
        ids = [t["id"] for t in FIXTURES["tokens"]]
        self.assertEqual(len(ids), len(set(ids)))
        states = set()
        for token in FIXTURES["tokens"]:
            with self.subTest(token=token["id"]):
                groups = strip_groups(token["groups"])
                self.assertEqual(member_state(groups, token["roles"]), token["state"])
                self.assertEqual(clinician_only(token["roles"]), token["clinicianOnly"])
                states.add(token["state"])
        self.assertEqual(states, {"APPROVED", "PENDING", "INVALID"})
        approved = [t for t in FIXTURES["tokens"] if t["state"] == "APPROVED"]
        self.assertTrue(any(t["clinicianOnly"] for t in approved))
        self.assertTrue(any(not t["clinicianOnly"] and CLINICIAN in t["roles"] for t in approved), "mixed-role case present")
        self.assertTrue(any(t["clinicianOnly"] and t["state"] != "APPROVED" for t in FIXTURES["tokens"]),
                        "clinician-only pending/invalid still stops at the membership check")

    def test_03_gateway_identity_closure_rejects_human_roles(self):
        for identity in FIXTURES["gateway_identities"]:
            with self.subTest(identity=identity["id"]):
                adjacent, valid = gateway_identity(identity["method"], identity["azp"], identity["groups"], identity["roles"])
                self.assertTrue(adjacent)
                self.assertEqual(valid, identity["valid"])
        self.assertRegex(self.guard, r"const KIN_ROLES = new Set\(\[\.\.\.APP_ROLES, 'gateway'\]\);")
        self.assertRegex(self.guard, r"kinRoles\.length === 1 && kinRoles\[0\] === 'gateway'")

    def test_04_route_key_from_nest_metadata(self):
        for case in FIXTURES["route_metadata_cases"]:
            with self.subTest(case=case):
                key = route_key(case["method"], case["controller"], case["handler"])
                self.assertEqual(key, case["key"])
                self.assertEqual(allowed(key), case["allowed"])
        # 3 session cases from U1a plus one per U1b business row
        self.assertEqual(sum(1 for c in FIXTURES["route_metadata_cases"] if c["allowed"]), 3 + len(FIXTURES["business_routes"]))
        self.assertEqual({c["key"] for c in FIXTURES["route_metadata_cases"] if c["allowed"]}, ALLOWED)
        self.assertTrue(any(c["key"] is None for c in FIXTURES["route_metadata_cases"]))

    def test_05_every_route_has_exactly_one_matrix_row_and_the_counts_reconcile(self):
        """REQ-S5-U1c-ROUTE-COMPLETENESS / RISK-S5-U1c-NEW-ROUTE-LEAK: controllers - rows = {} and rows - controllers = {}."""
        inventory = controller_inventory()
        keys = {m + " " + p for m, p in inventory}
        public = {m + " " + p for (m, p), meta in inventory.items() if meta["public"]}
        self.assertEqual(public, PUBLIC, "the public four must stay exactly these")
        self.assertEqual(self.guard.count("SetMetadata('public', true)"), 1)
        listed = Counter(route for routes in (FIXTURES["public_routes"], FIXTURES["session_routes"],
                                              FIXTURES["business_routes"], *DENIED_GROUPS.values()) for route in routes)
        self.assertEqual(sorted(route for route, n in listed.items() if n > 1), [], "a route has more than one matrix row")
        rows = set(listed)
        self.assertEqual(sorted(keys - rows), [], "controller routes without a route_matrix row: classify each one "
                         "(session/business with a live case, or a denied basis); nothing is denied by subtraction")
        self.assertEqual(sorted(rows - keys), [], "route_matrix rows without a controller route")
        # D8: the same route set in the controllers, the invariants_live ROUTES table and this matrix, in both directions
        manifest = {m + " " + p for m, p in manifest_rows()}
        self.assertEqual(sorted(keys - manifest), [], "controller routes missing from invariants_live ROUTES")
        self.assertEqual(sorted(manifest - keys), [], "invariants_live ROUTES rows without a controller route")
        counts = {"routes": len(inventory), "public": len(PUBLIC), "session": len(SESSION), "business": len(BUSINESS),
                  "denied": len(DENIED_ROUTES)}
        self.assertEqual(counts, MATRIX["counts"], "route_matrix counts are the reconciled numbers of this head")
        self.assertEqual(len(manifest_rows()), counts["routes"])
        self.assertEqual(counts["routes"], counts["public"] + counts["session"] + counts["business"] + counts["denied"])
        self.assertEqual(set(DENIED_GROUPS), set(MATRIX["basis_legend"]), "every denied row names a basis of the legend")
        self.assertTrue(all(DENIED_GROUPS.values()))
        # the model's decision on every row: session and business pass, every denied row is refused
        self.assertTrue(ALLOWED.isdisjoint(PUBLIC) and ALLOWED.isdisjoint(DENIED_ROUTES))
        for key in sorted(keys - PUBLIC):
            self.assertEqual(allowed(key), key in ALLOWED, key)
        # every route added since the 104-row baseline has its own row with decision, unit, commit and basis
        added = sorted(keys - BASELINE)
        removed = sorted(BASELINE - keys)
        self.assertEqual(removed, [], "a baseline route disappeared; re-check the planning inventory")
        post = MATRIX["post_baseline"]
        self.assertEqual(sorted(post), added, "exactly the routes added since the baseline carry a post_baseline row")
        where = {**{r: "public" for r in PUBLIC}, **{r: "session" for r in SESSION}, **{r: "business" for r in BUSINESS},
                 **{r: "denied" for r in DENIED_ROUTES}}
        for key, row in sorted(post.items()):
            with self.subTest(post_baseline=key):
                self.assertEqual(set(row), {"decision", "unit", "commit", "basis"})
                self.assertEqual(row["decision"], where[key], "the post_baseline decision is the row the route sits in")
                self.assertRegex(row["commit"], r"^[0-9a-f]{7,40}$")
                self.assertRegex(row["unit"], r"^S[0-9]-")
                self.assertGreater(len(row["basis"].strip()), 20)
                self.assertEqual(allowed(key), row["decision"] in ("session", "business"))
        declared = set(FIXTURES["allowed_additions"])
        self.assertEqual({k for k, row in post.items() if row["decision"] == "business"}, declared)
        self.assertTrue(declared <= ALLOWED)
        for key in FIXTURES["must_stay_denied"]:
            self.assertIn(key, DENIED_ROUTES, f"{key} carries drafts, writer fields or non-final bodies")
        print("CLINICIAN_POLICY_INVENTORY " + json.dumps({
            "counts": counts, "public": sorted(public), "allowed": sorted(ALLOWED),
            "denied_by_basis": {basis: len(routes) for basis, routes in sorted(DENIED_GROUPS.items())},
            "baseline_routes": len(BASELINE), "removed_since_baseline": removed,
            "newly_classified": {key: post[key]["decision"] for key in added},
            "allowed_additions": sorted(declared),
        }, ensure_ascii=True, sort_keys=True))

    def test_06_guard_source_pins(self):
        guard = self.guard
        self.assertIn("import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';", guard)
        self.assertRegex(guard, r"import \{\s*APP_ROLES, CLINICIAN_ROUTE_DENIED, clinicianOnly, clinicianRouteAllowed, routeKey,?\s*\} from './clinician-policy';")
        self.assertNotIn("new Set(['radiologist'", guard, "guard must not keep its own role literal")
        self.assertIn("req.roles = ['radiologist', 'technician', 'admin'];", guard, "AUTH_REQUIRED=false dev roles unchanged (no clinician)")
        self.assertIn("const isLogout = req.method === 'POST' && path === '/api/auth/logout';", guard)
        self.assertIn("if (state !== 'APPROVED' && !isLogout)", guard)
        membership = guard.index("code: state === 'PENDING' ? 'INSTITUTION_PENDING' : 'INSTITUTION_INVALID'")
        gate = guard.index("req.clinicianOnly = clinicianOnly(req.roles);")
        csrf = guard.index("req.headers['x-kin-csrf'] !== '1'")
        returned = guard.rindex("return true;")
        self.assertLess(membership, gate)
        self.assertLess(gate, csrf)
        self.assertLess(csrf, returned)
        block = guard[gate:csrf]
        self.assertRegex(block, r"if \(req\.clinicianOnly\) \{")
        self.assertRegex(block, r"routeKey\(\s*this\.reflector\.get\(METHOD_METADATA, ctx\.getHandler\(\)\),\s*this\.reflector\.get\(PATH_METADATA, ctx\.getClass\(\)\),\s*this\.reflector\.get\(PATH_METADATA, ctx\.getHandler\(\)\),\s*\)")
        self.assertRegex(block, r"if \(!clinicianRouteAllowed\(key\)\)\s*throw new ForbiddenException\(\{ code: CLINICIAN_ROUTE_DENIED \}\);")
        self.assertNotIn("originalUrl", block, "the gate reads route metadata, not the request URL")
        gateway_return = guard.index("req.kind = 'gateway';")
        self.assertLess(gateway_return, membership, "gateway identities return before the member checks")

    def test_07_member_console_and_keycloak_client_share_the_role_list(self):
        self.assertIn("import { APP_ROLES } from './clinician-policy';", self.admin)
        self.assertNotIn("new Set(['radiologist'", self.admin)
        self.assertIn("if (roles.some(role => !APP_ROLES.has(role)))", self.admin)
        self.assertIn("const roles = user.roles.filter(role => APP_ROLES.has(role)).sort();", self.admin)
        self.assertIn("import { APP_ROLES as MANAGED_ROLES } from './clinician-policy';", self.keycloak)
        self.assertNotIn("new Set(['radiologist'", self.keycloak)
        self.assertIn("if (roles.some(role => !MANAGED_ROLES.has(role)))", self.keycloak)
        self.assertIn("MANAGED_ROLES.has(role.name) && !wanted.has(role.name)", self.keycloak)
        # colleagues/reviewer candidates stay radiologist-only; a clinician is never a reviewer candidate
        self.assertIn("u.roles.includes('radiologist')", self.keycloak)
        # the self-protection and the admin predicate of the member console are unchanged
        self.assertIn("if (!c.roles?.includes('admin')) throw new ForbiddenException", self.admin)
        self.assertIn("!this.roles(body.roles).includes('admin')", self.admin)

    def test_08_realm_defines_the_role_without_users_or_secrets(self):
        realm = json.loads(REALM.read_text(encoding="utf-8"))
        names = [r["name"] for r in realm["roles"]["realm"]]
        self.assertEqual(names, ["radiologist", "technician", "admin", "clinician", "gateway"])
        clinician = next(r for r in realm["roles"]["realm"] if r["name"] == "clinician")
        self.assertEqual(set(clinician), {"name", "description"})
        for user in realm["users"]:
            self.assertNotIn("clinician", user.get("realmRoles", []), "no imported clinician account; identities are test-owned")
            self.assertNotIn("credentials", user)
        for client in realm["clients"]:
            secret = client.get("secret")
            self.assertTrue(secret is None or secret.startswith("${"), client["clientId"])

    def test_09_u1b_read_rows_are_narrow_scoped_and_final_gated_in_source(self):
        """S5-U1b source pins. Runtime proof is clinician_read_live.py; these catch a narrow path being widened."""
        read = lambda name: (API / name).read_text(encoding="utf-8")  # noqa: E731
        controller, service = read("pacs.controller.ts"), read("pacs.service.ts")
        viewer, preview = read("viewer.controller.ts"), read("report-preview.controller.ts")
        items = read("viewer.service.ts")
        contract = FIXTURES["read_contract"]
        self.assertEqual(ts_array(self.policy, "CLINICIAN_FINAL_ACTIONS"), contract["final_actions"])
        self.assertEqual(ts_array(self.policy, "CLINICIAN_OPEN_STATES"), contract["open_states"])
        self.assertRegex(self.policy, r"return rs === 'A' && typeof action === 'string' && CLINICIAN_FINAL_ACTIONS\.includes\(action\)")
        # both new rows live in the report-preview controller (no-store middleware, StudyAccess interceptor) and go
        # straight to their clinician service method; pacs.controller.ts, whose bytes S4-U5 pins, gains nothing
        for route, call in (("clinician/studies", "this.pacs.clinicianStudies(member(req), query)"),
                            ("clinician/studies/:uid/report", "this.pacs.clinicianReportRead(uid, member(req))")):
            block = re.search(rf"@Get\('{re.escape(route)}'\)\n(.*?)\n  \}}", preview, re.S)
            self.assertIsNotNone(block, route)
            self.assertIn("return " + call + ";", block.group(1))
        self.assertNotIn("clinician", controller)
        # the clinician list IS the worklist enumeration (same tenant/tele/StudyAccess/page/recheck), narrowed after it
        body = re.search(r"\n  async clinicianStudies\(c: Caller, query\?: any\) \{\r?\n(.*?)\r?\n  \}\r?\n", service, re.S).group(1)
        lines = [line.strip() for line in body.splitlines()]
        self.assertEqual(lines[:2], ["this.clinicianCaller(c);", "const list = await this.listStudies(c, query);"])
        self.assertEqual(lines[-1], "return clinicianList(list, current);")
        self.assertIn("if (clinicianListChanged(list.studies, current))", body)
        # S5-U1b-F02: scope and report status (rs, signer, date, Report.version, head action) come from ONE statement —
        # one snapshot — and the rows are projected from it; no second StudyState/Report read is merged in
        self.assertEqual(body.count("$queryRaw"), 1, "one statement reads the whole report status")
        self.assertEqual(body.count("await "), 2, "listStudies and the one snapshot statement are the only reads")
        snapshot = body[body.index("$queryRaw"):]
        for fragment in ('SELECT s.uid, s."institutionId", s."teleInstitutionId", s.rs, s."repDoc", s.confirm,',
                         "COALESCE(r.version, 0) AS version, v.action", 'FROM "StudyState" s',
                         'LEFT JOIN "Report" r ON r.uid = s.uid',
                         'LEFT JOIN "ReportVersion" v ON v.uid = r.uid AND v.version = r.version'):
            self.assertIn(fragment, snapshot, fragment)
        for token in ("findings", "reportDraft", "toClient", "notObserved", "orderReconciliation", "gatewayReceipt",
                      "findMany", "findUnique"):
            self.assertNotIn(token, body, token)
        self.assertEqual(ts_array(self.policy, "CLINICIAN_LIST_PINS"), contract["list_snapshot_pins"])
        self.assertIn("report: clinicianReportStatus(record, record ? { version: record.version, action: record.action } : null),", self.policy)
        self.assertIn("return !state || CLINICIAN_LIST_PINS.some(key => (state[key] ?? null) !== (seen[key] ?? null));", self.policy)
        self.assertNotIn("head.version === state.version", self.policy, "the worklist row's own version never pins a head")
        scope = re.search(r"\n  private async clinicianScope<T>\(.*?\n  \}\r?\n", service, re.S).group(0)
        self.assertIn("need(c.roles, CLINICIAN_ROLE, '임상의 조회');", service)
        self.assertIn("this.clinicianCaller(c);", scope)
        self.assertIn("const state = await this.gate(uid, c, tx);", scope)
        self.assertIn("if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');", scope)
        self.assertIn("where: { uid_version: { uid, version: report.version } },", scope)
        self.assertIn("isolationLevel: 'RepeatableRead'", scope)
        self.assertIn("if (!report.final) return { uid, report, keys: null };", service)
        statistics = service[service.index("if (path === '/statistics') {"):service.index("// /dicom-web/studies/{uid}/")]
        closed = statistics.index("if (clinicianOnly(c.roles)) throw new ForbiddenException(")
        self.assertLess(closed, statistics.index("return;"), "the server-wide count closes for clinician-only before it passes")
        # viewer items: clinician-only branch pinned to ONE signed version (S5-U1b-F01), not a boolean asked twice:
        # gate -> items read in the same statement as the signed head of that version -> gate again, all compared
        self.assertIn("return clinicianOnly(c.roles) ? this.clinicianItems(uid, query, c) : this.svc.list(uid, query, c);", viewer)
        branch = viewer[viewer.index("private async clinicianItems("):]
        branch = branch[:branch.index("\n  }")]
        steps = ("const version = await this.pacs.clinicianViewerHead(uid, c);",
                 "if (version === null) return clinicianViewerWithheld(uid);",
                 "const result = await this.svc.listFinal(uid, continued ? { ...rest, cursor: continued.after } : rest, c, version);",
                 "if (!clinicianViewerPinned(version, result.finalVersion, await this.pacs.clinicianViewerHead(uid, c))) throw changed();",
                 "return clinicianViewerPage(uid, version, result, VIEWER_CURSOR_KEY);")
        positions = [branch.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions), "gate, pinned read, gate+compare, answer — in this order")
        self.assertIn("new ConflictException({ code: CLINICIAN_VIEWER_CHANGED, message });", viewer)
        self.assertEqual(branch.count("clinicianViewerHead(uid, c)"), 2)
        self.assertNotIn("this.svc.list(", branch, "the clinician path never reads items without the signed head")
        for source in (viewer, service):
            self.assertNotIn("clinicianViewerFinal", source, "a boolean gate cannot see reset -> re-approve")
        self.assertIn("clinicianFinal(state.rs, head) ? head.version as number : null", service)
        self.assertRegex(self.policy, r"return Number\.isSafeInteger\(before\) && \(before as number\) > 0 && read === before && after === before;")
        self.assertEqual(re.search(r"export const CLINICIAN_VIEWER_CHANGED = '([A-Z_]+)';", self.policy).group(1),
                         contract["viewer_changed_code"])
        # the signed head and the items are one SQL statement: the head CTE, its column and the item filter
        listed = items[items.index("async listFinal("):items.index("async write(")]
        for fragment in ('SELECT r.version FROM "Report" r',
                         'JOIN "StudyState" s ON s.uid = r.uid',
                         'JOIN "ReportVersion" v ON v.uid = r.uid AND v.version = r.version',
                         "WHERE r.uid = ${uid} AND r.version > 0 AND s.rs = 'A' AND v.action IN (${Prisma.join([...CLINICIAN_FINAL_ACTIONS])})",
                         "Prisma.sql`, final_head AS (${signed})`",
                         "Prisma.sql`(SELECT version FROM final_head) AS \"finalVersion\",`",
                         "Prisma.sql`AND EXISTS(SELECT 1 FROM final_head f WHERE f.version = ${final}::int)`"):
            self.assertIn(fragment, listed, fragment)
        statement = listed[listed.index("const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent})${signedHead}"):]
        statement = statement[:statement.index("AS rows`;") + len("AS rows`;")]
        for fragment in ("${signedHead}", "${signedColumn}", "WHERE (${page.includeHidden} OR NOT i.hidden) ${signedItems}"):
            self.assertIn(fragment, statement, fragment)
        self.assertIn("if (!Number.isSafeInteger(final) || final < 1) denied();", listed)
        self.assertIn("return this.read(uid, query, c, id, null);", items, "the legacy list keeps the unsigned statement")
        # report-preview returns bodies at every RS; clinician-only is refused before any read
        guard_at = preview.index("if (clinicianOnly(caller.roles)) throw new ForbiddenException({ code: CLINICIAN_ROUTE_DENIED });")
        self.assertLess(guard_at, preview.index("this.prisma.studyState.findUnique"))
        # both new rows sit in the REPORT battery of invariants_live (technician, preliminary third party, other tenant)
        manifest = MANIFEST.read_text(encoding="utf-8")
        self.assertIn('("GET", "clinician/studies"): Route(Kind.REPORT, "clinician-studies", "collection"),', manifest)
        self.assertIn('("GET", "clinician/studies/:uid/report"): Route(Kind.REPORT, "clinician-report"),', manifest)

    def test_10_viewer_pages_continue_only_on_the_signed_version_they_started(self):
        """S5-U1b-F04 source pins. Runtime proof is the serializer chain vectors and clinician_read_live test_06b."""
        read = lambda name: (API / name).read_text(encoding="utf-8")  # noqa: E731
        viewer, items = read("viewer.controller.ts"), read("viewer.service.ts")
        # one process-local key, made in the controller module and never read from configuration
        self.assertIn("import { randomBytes } from 'node:crypto';", viewer)
        self.assertEqual(re.findall(r"const VIEWER_CURSOR_KEY = (.*);", viewer), ["randomBytes(32)"])
        self.assertNotIn("process.env", viewer)
        branch = viewer[viewer.index("private async clinicianItems("):]
        branch = branch[:branch.index("\n  }")]
        # the continuation is judged before the gate, and the gate's head is compared with its version before anything
        # is read or withheld; the one version that passes is the pin of listFinal and of the last check
        steps = ("const page = clinicianViewerQuery(query);",
                 "const { cursor, ...rest } = page;",
                 "const continued = cursor === undefined ? null : clinicianViewerContinuation(VIEWER_CURSOR_KEY, uid, cursor);",
                 "if (cursor !== undefined && !continued) throw changed(",
                 "const version = await this.pacs.clinicianViewerHead(uid, c);",
                 "if (!clinicianViewerContinues(continued?.version ?? null, version)) throw changed();",
                 "if (version === null) return clinicianViewerWithheld(uid);",
                 "const result = await this.svc.listFinal(uid, continued ? { ...rest, cursor: continued.after } : rest, c, version);",
                 "if (!clinicianViewerPinned(version, result.finalVersion, await this.pacs.clinicianViewerHead(uid, c))) throw changed();",
                 "return clinicianViewerPage(uid, version, result, VIEWER_CURSOR_KEY);")
        positions = [branch.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions), "verify continuation, gate, compare, withhold, pinned read, recheck, answer")
        # the caller's cursor never reaches the item read; only the verified boundary does, and every answer is signed
        self.assertEqual(branch.count("cursor: continued.after"), 1)
        self.assertNotIn("listFinal(uid, page,", branch)
        self.assertEqual(branch.count("VIEWER_CURSOR_KEY"), 2)
        # policy: signed {v, uid, version, after}; HMAC-SHA256 compared in constant time over canonical base64url; key >= 32 bytes
        for fragment in (
                "import { createHmac, timingSafeEqual } from 'node:crypto';",
                "if (!(key instanceof Uint8Array) || key.length < 32) throw new Error(",
                "return createHmac('sha256', key).update(payload).digest();",
                "const payload = Buffer.from(JSON.stringify({ v: 1, uid, version, after }), 'utf8').toString('base64url');",
                "if (actual.toString('base64url') !== signature || actual.length !== expected.length"
                " || !timingSafeEqual(actual, expected)) return null;",
                "data.v !== 1 || data.uid !== uid || !Number.isSafeInteger(data.version) || data.version < 1",
                "return started === null || (Number.isSafeInteger(head) && (head as number) > 0 && head === started);",
                "if (!Number.isSafeInteger(version) || version < 1) throw new Error('a final viewer page needs its signed report version');",
                "nextCursor: typeof page?.nextCursor === 'string' ? clinicianViewerCursor(key, uid, version, page.nextCursor) : null };"):
            self.assertIn(fragment, self.policy, fragment)
        contract = FIXTURES["read_contract"]
        self.assertEqual(int(re.search(r"export const CLINICIAN_VIEWER_CURSOR_MAX = (\d+);", self.policy).group(1)),
                         contract["viewer_cursor_max"])
        # the final page names its version; the withheld answer keeps exactly its four keys
        self.assertIn("return { uid, final: true, reportVersion: version, items,", self.policy)
        self.assertIn("return { uid, final: false, items: null, nextCursor: null };", self.policy)
        self.assertEqual(sorted(contract["viewer_page_keys"]), sorted(contract["viewer_withheld_keys"] + ["reportVersion"]))
        # the radiologist path is untouched: the unsigned statement and the bare item id as its cursor
        self.assertIn("return clinicianOnly(c.roles) ? this.clinicianItems(uid, query, c) : this.svc.list(uid, query, c);", viewer)
        self.assertIn("return this.read(uid, query, c, id, null);", items)
        self.assertIn("return { items, nextCursor: pageRow.rows.length > page.limit ? items[items.length - 1].id : null,", items)

    def test_11_decorator_runs_attribute_public_to_the_handler_it_decorates(self):
        """S5-U1c D5. The S5-U1a reading gave a @Public() found between two route decorators to the later route."""
        def read(source):
            return [handler[:3] for handler in controller_handlers(Path("sample.controller.ts"), source)]

        above = "@Controller('x')\nexport class A {\n  @Public()\n  @Get('a')\n  a() {}\n\n  @Get('b')\n  b() {}\n}\n"
        self.assertEqual(read(above), [("GET", "a", True), ("GET", "b", False)])
        one_line = ("@Controller()\nexport class A{constructor(private s: S){}\n"
                    "  @Get('a') a(@Req() r:any,@Query() q:any){return this.s.a(r, q);}\n"
                    "  @Post() @HttpCode(200)\n  b(@Body() b:any, @Res({ passthrough: true }) res:any){}\n}\n")
        self.assertEqual(read(one_line), [("GET", "a", False), ("POST", "", False)])
        below = "@Controller()\nexport class A {\n  @Get('a')\n  @Public()\n  a() {}\n\n  @Get('b')\n  b() {}\n}\n"
        # control: the previous reading marks b public and a not — the opposite of what Nest applies
        self.assertEqual(previous_public_attribution(below), {"a": False, "b": True})
        refused = {
            "public below its route": below,
            "public on the class": "@Public()\n@Controller()\nexport class A {\n  @Get('a')\n  a() {}\n}\n",
            "public without a route": "@Controller()\nexport class A {\n  @Public()\n  helper() {}\n}\n",
            "public on a parameter": "@Controller()\nexport class A {\n  @Get('a')\n  a(@Public() x: any) {}\n}\n",
            "two route decorators": "@Controller()\nexport class A {\n  @Get('a')\n  @Post('a')\n  a() {}\n}\n",
            "computed path": "@Controller()\nexport class A {\n  @Get(PATH)\n  a() {}\n}\n",
        }
        for label, source in refused.items():
            with self.subTest(refused=label), self.assertRaises(AssertionError):
                controller_handlers(Path("sample.controller.ts"), source)
        # the real controllers: each public handler's own run is exactly @Public() directly above its route decorator
        found = []
        for path in sorted(API.rglob("*.controller.ts")):
            for run in decorator_runs(path.read_text(encoding="utf-8")):
                names = [name for name, _start, _end in run["items"]]
                if "Public" in names:
                    self.assertEqual((run["kind"], len(names), names[0]), ("member", 2, "Public"), path.name)
                    self.assertIn(names[1], HTTP_DECORATORS, path.name)
                    found.append(path.name)
        self.assertEqual(sorted(found), ["auth.controller.ts"] * 3 + ["pacs.controller.ts"])

    def test_12_inventory_readers_see_every_route_decorator_and_method(self):
        """S5-U1c D6 (RequestMethod members, unreadable decorators) and D8 (the invariants_live reader)."""
        known = set(HTTP_DECORATORS) | set(FIXTURES["controller_decorators"]["non_route"])
        seen = set()
        for path in sorted(API.rglob("*.controller.ts")):
            for run in decorator_runs(path.read_text(encoding="utf-8")):
                seen |= {name for name, _start, _end in run["items"]}
        self.assertEqual(sorted(seen - known), [], "a controller decorator the inventory neither reads nor classifies")
        # a controller or route outside *.controller.ts is invisible to both inventories: every other file goes through the
        # same lexer and runs (S5-U1c-F03), and together they use exactly the classified names
        sources = api_sources()
        outside = {path.name: outside_decorators(path, source) for path, source in sources.items()
                   if not path.name.endswith(".controller.ts")}
        self.assertEqual(len(outside) + len(list(API.rglob("*.controller.ts"))), len(sources))
        self.assertEqual({name for names in outside.values() for name in names}, OUTSIDE_DECORATORS)
        # the model knows every method the inventory can produce; a number it does not know fails closed, and the
        # allowlist names only GET and POST, so a member the model lacks can never match a row in model or product
        pin = FIXTURES["request_method_pin"]
        lock = json.loads(LOCKFILE.read_text(encoding="utf-8"))
        self.assertEqual(lock["packages"]["node_modules/" + pin["package"]]["version"], pin["lock_version"],
                         "Nest moved: re-read RequestMethod of the new version, then update request_method_enum and this pin")
        self.assertEqual(sorted(METHOD_ENUM), list(range(len(METHOD_ENUM))))
        self.assertTrue(set(HTTP_DECORATORS.values()) <= set(METHOD_ENUM.values()))
        self.assertEqual({key.split(" ", 1)[0] for key in ALLOWED}, {"GET", "POST"})
        for number in (-1, *range(len(METHOD_ENUM), 64), 2 ** 31):
            with self.subTest(method=number):
                self.assertIsNone(route_key(number, "/", "me"))
                self.assertFalse(allowed(route_key(number, "/", "me")))
        self.assertIn("RequestMethod[method]", self.policy)
        # D8: invariants_live reads the same decorator table from the same files, and its ROUTES keys are unique
        text = MANIFEST.read_text(encoding="utf-8")
        table = re.search(r"\n    http_decorators = \{\n(.*?)\n    \}\n", text, re.S)
        self.assertIsNotNone(table)
        self.assertEqual(dict(re.findall(r'"(\w+)": "([A-Z]+)"', table.group(1))), HTTP_DECORATORS)
        self.assertIn('CONTROLLER_GLOB = "*.controller.ts"', text)
        self.assertIn("for path in sorted(controller_dir.rglob(CONTROLLER_GLOB)):", text)
        rows = manifest_rows()
        self.assertEqual(len(rows), len(set(rows)), "a repeated ROUTES key is collapsed silently by the dict")

    def test_13_role_composition_neither_downgrades_a_mixed_user_nor_widens_a_clinician(self):
        """RISK-S5-U1c-MIXED-DOWNGRADE in the model over every route, and the only narrowing sites in the source."""
        routes = {m + " " + p for m, p in controller_inventory()} - PUBLIC
        kinds, mixed = Counter(), set()
        for token in FIXTURES["tokens"]:
            if token["state"] != "APPROVED":
                continue
            app = {role for role in token["roles"] if role in APP_ROLES}
            only = clinician_only(token["roles"])
            kind = "clinician-only" if only else "mixed" if CLINICIAN in app else "legacy"
            kinds[kind] += 1
            if kind == "mixed":
                mixed |= app & LEGACY_ROLES
            with self.subTest(token=token["id"], kind=kind):
                self.assertEqual(only, app == {CLINICIAN})
                decisions = {key: ("allowed" if allowed(key) else "denied") if only else "legacy" for key in routes}
                if only:
                    self.assertEqual({k for k, d in decisions.items() if d == "allowed"}, ALLOWED)
                    self.assertEqual({k for k, d in decisions.items() if d == "denied"}, DENIED_ROUTES)
                else:
                    self.assertEqual(set(decisions.values()), {"legacy"}, "a legacy role keeps every existing path")
        self.assertEqual(set(kinds), {"clinician-only", "mixed", "legacy"})
        self.assertEqual(mixed, LEGACY_ROLES, "each legacy role is fixed alongside clinician")
        # clinicianOnly() is the one narrowing predicate, at the listed sites; a role-presence test would narrow a mixed user
        sites = {
            "auth.guard.ts": "req.clinicianOnly = clinicianOnly(req.roles);",
            "viewer.controller.ts": "return clinicianOnly(c.roles) ? this.clinicianItems(uid, query, c) : this.svc.list(uid, query, c);",
            "report-preview.controller.ts": "if (clinicianOnly(caller.roles)) throw new ForbiddenException({ code: CLINICIAN_ROUTE_DENIED });",
            "pacs.service.ts": "if (clinicianOnly(c.roles)) throw new ForbiddenException('전체 검사 통계를 열람할 수 없습니다');",
        }
        counted = {}
        for path in sorted(API.rglob("*.ts")):
            if path == POLICY:
                continue
            source = path.read_text(encoding="utf-8")
            calls = len(re.findall(r"\bclinicianOnly\(", source))
            if calls:
                counted[path.name] = calls
            self.assertIsNone(re.search(r"includes\(\s*(?:'clinician'|\"clinician\"|CLINICIAN_ROLE)\s*\)", source), path.name)
        self.assertEqual(counted, FIXTURES["role_composition"]["clinician_only_call_sites"])
        self.assertEqual(set(sites), set(counted))
        for name, line in sites.items():
            self.assertIn(line, (API / name).read_text(encoding="utf-8"), name)
        # the clinician reads admit a mixed user by role; they never require clinician-only
        self.assertIn("need(c.roles, CLINICIAN_ROLE, '임상의 조회');", (API / "pacs.service.ts").read_text(encoding="utf-8"))
        live = LIVE_MODULE.read_text(encoding="utf-8")
        self.assertIn("def " + FIXTURES["role_composition"]["live_test"] + "(self) -> None:", live)
        self.assertIn('"' + FIXTURES["role_composition"]["live_marker"] + ' "', live)

    def test_14_live_matrix_gives_every_allow_row_a_positive_a_wrong_role_and_a_wrong_tenant_case(self):
        """TEST-S5-U1c-LIVE-MATRIX is data here and one loop in clinician_policy_live.py test_05.

        S5-U4a: an allow row whose handler answers 201 is a write row. Its write names the method, the request body, the
        expected status and the audit rows its positive writes; its wrong_role and wrong_tenant are denials. Every other
        row keeps the read contract (200/204, no audit row). The live loop checks each case against the AuditLog rows it
        caused, and the :id question comes from the helpers TEST-S5-U4a-LIVE runs on.
        """
        matrix = FIXTURES["live_matrix"]
        rows = matrix["rows"]
        self.assertEqual(set(rows), ALLOWED, "every allow row, and only the allow rows, has live cases")
        wanted = {"positive": {"allowed"}, "wrong_role": {"denied"}, "wrong_tenant": {"denied", "absent"}}
        inventory = controller_inventory()
        statuses = handler_statuses()
        self.assertEqual(set(statuses), {method + " " + path for method, path in inventory}, "the same handlers")
        fill = set(matrix["fill"])
        self.assertEqual(fill, {"$request_id", "$owner", "$revision"})
        exceptions = []
        for route, row in sorted(rows.items()):
            with self.subTest(route=route):
                method = route.split(" ", 1)[0]
                write = row.get("write")
                self.assertEqual(set(row) - {"via", "query", "write"}, set(wanted))
                self.assertEqual(write is not None, statuses[route] == 201, f"{route}: its handler answers {statuses[route]}")
                if "via" not in row:
                    self.assertEqual(row["positive"]["status"], statuses[route], "the status the handler declares")
                if "query" in row:
                    self.assertEqual(method, "GET")
                    self.assertRegex(row["query"], r"^[a-z]+=[a-z]+(?:&[a-z]+=[a-z]+)*$")
                self.assertEqual(row["positive"]["as"], "clinician", "the positive is the clinician-only member of the study's institution")
                self.assertNotEqual(row["wrong_role"]["as"], "clinician")
                self.assertNotIn(row["wrong_tenant"]["as"], ("clinician", "doctor"))
                answered = (write["expected_status"],) if write is not None else (200, 204)
                for name, expected in wanted.items():
                    case = row[name]
                    self.assertTrue({"as", "expect", "status", "code"} <= set(case), name)
                    self.assertIn(case["as"], matrix["identities"])
                    self.assertNotEqual(case["code"], FIXTURES["denied_code"], "an allow row is never answered by the clinician gate")
                    self.assertIn(case["status"], answered if case["expect"] in ("allowed", "absent") else (403, 404))
                    self.assertEqual("absent" in case, case["expect"] == "absent", name)
                    if case["expect"] == "absent":
                        self.assertIsNone(write, "a write answers no collection")
                        self.assertEqual(set(case["absent"]), {"list", "field", "value"})
                        self.assertIn(case["absent"]["value"], (":uid", ":id"))
                    if case["expect"] not in expected:
                        exceptions.append((route, name, case["expect"]))
                        self.assertTrue(case.get("basis", "").startswith("by design"), f"{route} {name}")
                if write is None:
                    continue
                self.assertEqual(set(write), {"method", "body", "expected_status", "audit"})
                self.assertEqual((method, write["method"], write["expected_status"]), ("POST", "POST", 201))
                self.assertEqual(row["positive"]["expect"], "allowed")
                body = write["body"]
                self.assertEqual((body.get("requestId"), body.get("expectedOwner")), ("$request_id", "$owner"),
                                 "requestId and expectedOwner are the run's values, never literals")
                for key, value in body.items():
                    if isinstance(value, str) and value.startswith("$"):
                        self.assertIn(value, fill, key)
                    else:
                        self.assertTrue(value == "" or isinstance(value, str) and value.startswith("SYNTHETIC"), key)
                self.assertEqual("$revision" in body.values(), ":id" in route, "a revision belongs to the :id question")
                audit = write["audit"]
                self.assertEqual(set(audit), {"action", "source", "rows", "actor", "target", "detail"})
                source, constant = audit["source"]
                self.assertIn(f"export const {constant} = '{audit['action']}';", (API / source).read_text(encoding="utf-8"))
                self.assertIs(type(audit["rows"]), int)
                self.assertGreaterEqual(audit["rows"], 1, "a clinician write leaves its audit row")
                self.assertEqual((audit["actor"], audit["target"]), (row["positive"]["as"], ":uid"))
                self.assertEqual(audit["detail"].get("requestId"), "$request_id", "the audit row is this request's")
                for value in audit["detail"].values():
                    if value.startswith("$"):
                        self.assertIn(value, set(body.values()))
        self.assertEqual(exceptions, [("POST auth/logout", "wrong_tenant", "allowed")], "the logout exception is the one by-design non-denial")
        for route in ("GET clinician/studies", "GET clinician/studies/:uid/report"):
            self.assertEqual(rows[route]["wrong_role"]["as"], "doctor", "need('clinician') meets the same-institution radiologist")
        # S5-U4a: the question service's own role table meets a same-institution member of a role it does not admit, and
        # the other institution's clinician meets the owner-institution rule
        questions = sorted(m + " " + p for (m, p), found in inventory.items() if found["file"] == "clinician-question.controller.ts")
        self.assertEqual(len(questions), 6)
        for route in questions:
            with self.subTest(question=route):
                self.assertEqual(rows[route]["wrong_role"]["code"], "QUESTION_ROLE_REQUIRED")
                self.assertIn(rows[route]["wrong_role"]["as"], ("doctor", "tech"))
                self.assertEqual(rows[route]["wrong_tenant"]["as"], "kclinician")
        # the live module drives these cases from the fixture and creates every identity they name
        live = LIVE_MODULE.read_text(encoding="utf-8")
        self.assertIn("def " + matrix["test"] + "(self) -> None:", live)
        self.assertIn('LIVE_MATRIX = FIXTURES["live_matrix"]', live)
        self.assertIn('FILL = LIVE_MATRIX["fill"]', live)
        self.assertIn('"' + matrix["marker"] + ' "', live)
        self.assertIn('cls.stack.create_test_identity("kclinician", ["clinician"], "kin-center")', live)
        self.assertIn('self.create_member("cinvalid", ["clinician"], ["hallym", "kin-center"])', live)
        self.assertIn('self.stack.service_token("gateway")', live)
        self.assertIn('"a read or a refusal writes no audit row"', live)
        self.assertIn("cls.addClassCleanup(cls.drop_shared_questions)", live)
        # one implementation of the question helpers, the one TEST-S5-U4a-LIVE runs on; the policy module imports it
        shared = ("ask_question", "drop_study_questions", "lit", "member_owner", "read_question_row")
        self.assertIn("from clinician_question_live import " + ", ".join(shared) + "\n", live)
        question = QUESTION_LIVE.read_text(encoding="utf-8")
        for name in shared:
            self.assertEqual(len(re.findall(rf"^def {name}\(", question, re.M)), 1, name)
            self.assertNotIn(f"def {name}(", live, name)
        for use in ("drop_study_questions(uid, cls.owned_subjects())", "member_owner(self.stack, user)",
                    "ask_question(self.stack, user, uid, self.owner(user), body, rid)", "return read_question_row(qid)"):
            self.assertIn(use, question)
        # test_01 probes every controller route that is neither public nor allowed, then requires exactly the denied rows
        self.assertIn('DENIED_ROUTES = {route for routes in FIXTURES["route_matrix"]["denied"].values() for route in routes}', live)
        self.assertIn("self.assertEqual(sorted(swept), sorted(DENIED_ROUTES)", live)

    def test_15_invariants_member_summary_reads_the_policy_role_list(self):
        """S5-U1c D3: kc_user_summary compares Keycloak's roles with the product APP_ROLES, not a local literal."""
        text = MANIFEST.read_text(encoding="utf-8")
        function = re.search(r"\ndef policy_app_roles\(\) -> frozenset\[str\]:\n.*?(?=\n\n\n)", text, re.S)
        summary = re.search(r"\n    def kc_user_summary\(self, user_id: str\).*?(?=\n\n    def )", text, re.S)
        self.assertIsNotNone(function)
        self.assertIsNotNone(summary)
        self.assertIn("app = policy_app_roles()", summary.group(0))
        self.assertNotIn("radiologist", summary.group(0), "no local role literal")

        def run(root):
            namespace = {"ROOT": root, "re": re}
            exec(compile(function.group(0), str(MANIFEST), "exec"), namespace)
            return namespace["policy_app_roles"]()

        self.assertEqual(run(ROOT), frozenset(FIXTURES["app_roles"]))
        # controls on a copy: a changed APP_ROLES shape is refused instead of read as a partial set; a new role arrives
        with tempfile.TemporaryDirectory() as scratch:
            copy = Path(scratch) / "api" / "src" / "clinician-policy.ts"
            copy.parent.mkdir(parents=True)
            for label, old, new in (
                    ("clinician dropped from APP_ROLES", "new Set([...LEGACY_APP_ROLES, CLINICIAN_ROLE])", "new Set([...LEGACY_APP_ROLES])"),
                    ("legacy list not frozen", "Object.freeze(['radiologist', 'technician', 'admin'])", "['radiologist', 'technician', 'admin']")):
                self.assertIn(old, self.policy, label)
                copy.write_text(self.policy.replace(old, new), encoding="utf-8")
                with self.subTest(control=label), self.assertRaises(AssertionError):
                    run(Path(scratch))
            copy.write_text(self.policy.replace("'technician', 'admin']", "'technician', 'admin', 'nurse']"), encoding="utf-8")
            self.assertEqual(run(Path(scratch)), frozenset(FIXTURES["app_roles"]) | {"nurse"})

    def test_16_spaced_decorators_are_read_and_unsupported_shapes_refused(self):
        """S5-U1c-F01: '@Public ()' is valid TypeScript that the '@Name(' reader skipped, so the handler stayed private.

        Every '@' left after comments and literals are blanked must be a plain decorator call the inventory reads, every
        name must be read or classified, and decorator call text the inventory did not read (a comment too) stops it.
        Each refusal is matched by its message, so a lexer failure cannot stand in for the rule under test.
        """
        def read(source):
            return [handler[:3] for handler in controller_handlers(Path("sample.controller.ts"), source)]

        def sample(decorators):
            return "@Controller('x')\nexport class A {\n" + decorators + "  a() {}\n\n  @Get('b')\n  b() {}\n}\n"

        # control: the reader at 5226257 took '@Name(' only, so the spaced @Public above a route was no decorator at all
        self.assertEqual(re.findall(r"@([A-Za-z_]\w*)\(", sample("  @Public ()\n  @Get('a')\n")), ["Controller", "Get", "Get"])
        attributed = {"space": "@Public ()", "tab": "@Public\t()", "line break": "@Public\n  ()",
                      "space after @": "@ Public()", "comment": "@Public /* F01 */ ()"}
        for label, public in attributed.items():
            with self.subTest(above=label):
                self.assertEqual(read(sample(f"  {public}\n  @Get('a')\n")), [("GET", "a", True), ("GET", "b", False)])
        spaced_routes = {"space": "@Get ('a')", "line break": "@Get\n  ('a')", "space after @": "@ Get('a')"}
        for label, route in spaced_routes.items():
            with self.subTest(route=label):
                self.assertEqual(read(sample(f"  {route}\n")), [("GET", "a", False), ("GET", "b", False)])
        # '@' inside an import, a doc comment, a line comment, a regex class, strings and a template is not code; the
        # division inside the template expression stays code
        lexed = ("import { Controller, Get } from '@nestjs/common';\n"
                 "/** @param nothing: the inventory reads code only */\n"
                 "const AT = /[@'\"`]/g, MAIL = 'a@b', T = `@${'x'}@`;  // @see\n"
                 "@Controller('x')\nexport class A {\n  @Get ('a')\n  a() { return AT.test(MAIL) ? T : `${1 / 2}`; }\n}\n")
        self.assertEqual(read(lexed), [("GET", "a", False)])
        unsupported = "decorator shapes the inventory does not read"
        refused = {
            "spaced public below its route": (sample("  @Get('a')\n  @Public ()\n"), r"must sit above its route decorator"),
            "spaced public on the class": ("@Public ()\n" + sample("  @Get('a')\n"), r"decorator on a class"),
            "spaced public without a route": (sample("  @Public ()\n"), r"on a member without a route decorator"),
            "bare @Public": (sample("  @Public\n  @Get('a')\n"), unsupported),
            "qualified @Public": (sample("  @auth.Public()\n  @Get('a')\n"), unsupported),
            "parenthesised @Public": (sample("  @(Public())\n  @Get('a')\n"), unsupported),
            "type arguments": (sample("  @Public<any>()\n  @Get('a')\n"), unsupported),
            "unclassified, spaced": (sample("  @Version ('2')\n  @Get('a')\n"), r"neither reads nor classifies: \['Version'\]"),
            "RequestMapping, spaced": (sample("  @RequestMapping ('a')\n"), r"neither reads nor classifies: \['RequestMapping'\]"),
            "comment inside the route decorator": (sample("  @Get /* F01 */ ('a')\n"), r"unreadable route decorator"),
            "unterminated string": (sample("  @Get('a)\n"), r"unterminated literal"),
            "unterminated regex": (sample("  @Get('a')\n").replace("a() {}", "a() { return /x; }"), r"unterminated literal"),
            "unterminated comment": (sample("  /* @Public()\n  @Get('a')\n"), r"unterminated comment"),
            "unterminated template": (sample("  @Get('a')\n").replace("b() {}", "b() { return `x; }"), r"unterminated template"),
            "unclosed brace": (sample("  @Get('a')\n").replace("a() {}", "a() {"), r"unclosed"),
        }
        for label, (source, message) in refused.items():
            with self.subTest(refused=label), self.assertRaisesRegex(AssertionError, message):
                read(source)
        # the real controllers: a denied handler that gains a spaced @Public() changes the public set test_05 pins,
        # spaced route and controller decorators read the same 110 rows, and the unsupported shapes stop the inventory
        sources = api_sources()
        pacs = API / "pacs.controller.ts"
        route, key = "  @Get('studies')\n", "GET studies"
        self.assertIn(key, DENIED_ROUTES)
        baseline = controller_inventory(sources)
        self.assertEqual(len(baseline), MATRIX["counts"]["routes"])

        def edit(old, new):
            self.assertEqual(sources[pacs].count(old), 1, old)
            return {**sources, pacs: sources[pacs].replace(old, new)}

        def public(found):
            return {m + " " + p for (m, p), meta in found.items() if meta["public"]}

        self.assertEqual(public(baseline), PUBLIC)
        for label, decorator in attributed.items():
            with self.subTest(denied_gains_public=label):
                found = controller_inventory(edit(route, f"  {decorator}\n{route}"))
                self.assertEqual(set(found), set(baseline))
                self.assertEqual(public(found), PUBLIC | {key}, "the public set test_05 compares with PUBLIC changes")
        for label, old, new in (("spaced route", route, "  @Get ('studies')\n"),
                                ("route over a line break", route, "  @Get\n  ('studies')\n"),
                                ("spaced controller", "@Controller()", "@Controller ()")):
            with self.subTest(read=label):
                self.assertEqual(controller_inventory(edit(old, new)), baseline)
        for label, old, new, message in (
                ("spaced public below the route", route, route + "  @Public ()\n", r"must sit above its route decorator"),
                ("spaced public on the class", "@Controller()", "@Public ()\n@Controller()", r"decorator on a class"),
                ("bare @Public", route, "  @Public\n" + route, unsupported),
                ("unclassified, spaced", route, "  @Version ('2')\n" + route, r"neither reads nor classifies"),
                ("decorator call text in a comment", route, "  // @Public () since F01\n" + route,
                 r"decorator call text the inventory did not read")):
            changed = edit(old, new)
            with self.subTest(real_refused=label), self.assertRaisesRegex(AssertionError, message):
                controller_inventory(changed)
        print("CLINICIAN_POLICY_DECORATOR_SHAPES " + json.dumps({
            "public_attributed": sorted(attributed), "spaced_routes_read": sorted(spaced_routes),
            "refused": sorted(refused), "real_denied_route": key, "real_routes": len(baseline),
        }, ensure_ascii=True, sort_keys=True))

    def test_17_line_comments_end_at_every_line_terminator(self):
        """S5-U1c-F02: ECMAScript and TypeScript's scanner end a '//' comment at LF, CR, U+2028 or U+2029.

        code_mask ended it at LF only, so '// note<U+2028>  @Public /* c */ ()' above a denied handler was one comment:
        the handler stayed private and test_05, test_11 and test_12 passed. The raw-text check wanted '@Public (' with
        nothing but spaces and missed the same text. Each reader is checked here on its own.
        """
        terminators = {"LF": "\n", "CR": "\r", "U+2028": "\u2028", "U+2029": "\u2029"}
        for label, end in terminators.items():
            with self.subTest(lexer=label):
                source = f"// note{end}@Public() /* a{end}b */ `c{end}d`\n"
                code = code_mask(source)
                self.assertEqual(re.sub(r"\s", "", code), "@Public()", "what follows the terminator is code")
                self.assertEqual([i for i, c in enumerate(code) if c in LINE_TERMINATORS],
                                 [i for i, c in enumerate(source) if c in LINE_TERMINATORS], "terminators keep their offsets")
                self.assertEqual([name for run in decorator_runs(source) for name, _start, _end in run["items"]], ["Public"])
            # a regex holds no line terminator, escaped or not; a string goes on over an escaped one only
            for kind, source in (("regex", f"const r = /a{end}b/;\n"), ("escaped in a regex", f"const r = /a\\{end}b/;\n"),
                                 ("string", f"const s = 'a{end}b';\n")):
                with self.subTest(refused=kind, terminator=label), self.assertRaisesRegex(AssertionError, "unterminated literal"):
                    code_mask(source)
            with self.subTest(continued=label):
                self.assertEqual(re.sub(r"\s", "", code_mask(f"const s = 'a\\{end}b';\n")), "consts=;")
        # TypeScript skips U+200B and U+FEFF as whitespace, so the '/' after '[' still opens a regex literal
        for label, space in (("U+200B", "\u200b"), ("U+FEFF", "\ufeff")):
            with self.subTest(whitespace=label):
                self.assertEqual(code_mask(f"const r = [{space}/'/];\n"), f"const r = [{space}   ];\n")
        # the real controllers: the denied GET studies gains '@Public /* c */ ()' after a line comment that ends at CR,
        # U+2028 or U+2029; the public set test_05 compares with PUBLIC changes, and the raw-text check sees it alone
        sources = api_sources()
        pacs = API / "pacs.controller.ts"
        route, key = "  @Get('studies')\n", "GET studies"
        self.assertIn(key, DENIED_ROUTES)
        self.assertEqual(sources[pacs].count(route), 1)
        baseline = controller_inventory(sources)

        def insert(text):
            return {**sources, pacs: sources[pacs].replace(route, text + route)}

        for label in ("CR", "U+2028", "U+2029"):
            text = insert(f"  // ordinary comment{terminators[label]}  @Public /* annotation */ ()\n")[pacs]
            at, comment = text.index("@Public /* annotation */"), text.index("// ordinary comment")
            with self.subTest(denied_gains_public=label):
                self.assertGreater(text.index("\n", comment), at, "control: a comment ended at LF only swallows it")
                found = controller_inventory({**sources, pacs: text})
                self.assertEqual(set(found), set(baseline))
                self.assertEqual({m + " " + p for (m, p), meta in found.items() if meta["public"]}, PUBLIC | {key})
                self.assertIn(at, [offset for offset, _text in decorator_text(text)])
        # the raw-text check without the lexer: deciding call text the lexer blanks stops the inventory in every spelling;
        # a name that no call follows is prose and does not
        escaped = "@Pub" + "\\u" + "006cic()"
        blanked = {
            "comment between name and call": "  // @Public /* note */ ()\n",
            "call over lines in a block comment": "  /* @\n    Public\n    () */\n",
            "U+2029 inside a block comment": "  /* @Public\u2029() */\n",
            "qualified": "  // @auth.Public()\n",
            "parenthesised": "  // @(Public())\n",
            "escaped name": f"  // {escaped}\n",
            "in a string": "  note = '@Controller /* c */ (\"x\")';\n",
        }
        for label, text in blanked.items():
            with self.subTest(raw_text=label), \
                    self.assertRaisesRegex(AssertionError, r"decorator call text the inventory did not read"):
                controller_inventory(insert(text))
        self.assertEqual(controller_inventory(insert("  // @Public alone is no call\n")), baseline)
        print("CLINICIAN_POLICY_LINE_TERMINATORS " + json.dumps({
            "comment_ends_at": sorted(terminators), "real_denied_route": key, "raw_text_refused": sorted(blanked),
            "real_routes": len(baseline),
        }, ensure_ascii=True, sort_keys=True))

    def test_18_files_outside_the_controllers_get_the_same_decorator_reader(self):
        """S5-U1c-F03: both inventories open *.controller.ts only, and the other files were checked by a regex that wanted
        '@Name (' with nothing but spaces, so unlisted-routes.ts holding '@Controller /* c */ (...)' added routes that the
        matrix, ROUTES and the live sweep all missed while test_05 and test_12 passed. controller_inventory now reads every
        other api/src file with the same lexer and runs, so test_05 fails on such a file.
        """
        sources = api_sources()
        baseline = controller_inventory(sources)
        added = API / "unlisted-routes.ts"
        self.assertNotIn(added, sources)

        def inventory(text, path=added):
            return controller_inventory({**sources, path: text})

        def helper(member):
            # the import makes the controls valid TypeScript, which decorator_bindings requires since S5-U1c-F04; every
            # refusal below is raised by a check that runs before it
            return ("import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class Helper {\n" + member
                    + "  run() { return 1; }\n}\n")

        reviewed = ("@Controller /* boundary comment */ ('unlisted') export class UnlistedController { @Public () "
                    "@Get /* boundary comment */ ('read') read() { return {}; } }\n")
        # control: the regex test_12 used at 564e895 finds nothing in the reviewed file
        self.assertIsNone(re.search(rf"@\s*(Controller|RequestMapping|{ROUTE_NAMES})\s*\(", reviewed))
        misplaced = r"outside \*\.controller\.ts, a file neither inventory reads"
        unsupported = "decorator shapes the inventory does not read"
        unclassified = "outside_decorators does not classify"
        text = r"call text outside \*\.controller\.ts"
        escaped = "@G" + "\\u" + "0065t('read')"
        refused = {
            "reviewed source": (reviewed, misplaced),
            "comment between @ and name": ("@ /* c */ Controller('x')\nexport class X {}\n", misplaced),
            "line break between name and call": (helper("  @Get\n  ('read')\n"), misplaced),
            "space after @": (helper("  @ Post('x')\n"), misplaced),
            "after a comment ended by U+2028": (helper("  // note\u2028  @Put /* c */ ('x')\n"), misplaced),
            "@Public() alone": (helper("  @Public()\n"), misplaced),
            "RequestMapping": (helper("  @RequestMapping ('x')\n"), misplaced),
            "qualified": ("@common.Controller('x')\nexport class X {}\n", unsupported),
            "parenthesised": (helper("  @(Get('read'))\n"), unsupported),
            "escaped name": (helper(f"  {escaped}\n"), unsupported),
            "alias": (helper("  @Route('read')\n"), unclassified + r": \['Route'\]"),
            "SetMetadata": (helper("  @SetMetadata('public', true)\n"), unclassified + r": \['SetMetadata'\]"),
            "call text in a comment": (helper("  // @Get /* moved */ ('read')\n"), text),
            "call text in a string": (helper("  note = '@Controller (\"x\")';\n"), text),
            "unterminated literal": (helper("  other() { return 'x; }\n"), "unterminated literal"),
        }
        for label, (source, message) in refused.items():
            with self.subTest(refused=label), self.assertRaisesRegex(AssertionError, message):
                inventory(source)
        with self.subTest(refused="a .tsx script"), self.assertRaisesRegex(AssertionError, "a script neither inventory opens"):
            inventory(reviewed, API / "unlisted-routes.tsx")
        # controls: a plain service reads, and a mention that no call follows is prose
        self.assertEqual(inventory(helper("")), baseline)
        self.assertEqual(inventory(helper("  // see the @Public decorator in auth.guard.ts\n")), baseline)
        # a controller the matrix lacks, in a file the inventories do open, is a row test_05 finds missing
        opened = inventory("import { Controller, Get } from '@nestjs/common';\nimport { Public } from './auth.guard';\n"
                           "@Controller('unlisted')\nexport class UnlistedController {\n  @Public()\n  @Get('read')\n"
                           "  read() { return {}; }\n}\n", API / "unlisted.controller.ts")
        self.assertEqual(sorted(set(opened) - set(baseline)), [("GET", "unlisted/read")])
        self.assertTrue(opened[("GET", "unlisted/read")]["public"])
        self.assertNotIn("GET unlisted/read", PUBLIC | SESSION | BUSINESS | DENIED_ROUTES)
        # the compiler reads exactly the directory the inventories read, and no script kind they skip
        config = json.loads((ROOT / "api" / "tsconfig.json").read_text(encoding="utf-8"))
        self.assertEqual(config["include"], ["src/**/*"])
        self.assertNotIn("allowJs", config["compilerOptions"])
        with tempfile.TemporaryDirectory() as scratch:
            (Path(scratch) / "routes.tsx").write_text(reviewed, encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, r"scripts under api/src that neither inventory opens: \['routes\.tsx'\]"):
                api_sources(Path(scratch))
        print("CLINICIAN_POLICY_OUTSIDE_FILES " + json.dumps({
            "outside_files": sum(1 for path in sources if not path.name.endswith(".controller.ts")),
            "classified": sorted(OUTSIDE_DECORATORS), "refused": sorted(refused) + ["a .tsx script"],
            "real_routes": len(baseline),
        }, ensure_ascii=True, sort_keys=True))

    def test_19_decorator_names_are_bound_by_their_own_import(self):
        """S5-U1c-F04: the readers classify a decorator by its name and never asked what the name was imported as.

        'import { Get as Header }' and 'import { Public as HttpCode } from './auth.guard'' in the registered
        study-tags.controller.ts made '@HttpCode() @Header('unlisted')' a public GET that both inventories read as a
        status code and a header: 110 rows, public 4, test_05/11/12/13 green. 'Controller as Injectable, Get as Module'
        did the same in a file outside the controllers. decorator_bindings now ties every name to its module's own
        export and public_export ties Public to its declaration; each refusal is matched by its message.
        """
        sources = api_sources()
        baseline = controller_inventory(sources)
        self.assertEqual(len(baseline), MATRIX["counts"]["routes"])
        self.assertEqual({m + " " + p for (m, p), meta in baseline.items() if meta["public"]}, PUBLIC)
        # the table: one module per name a run may carry, and the real sources use each name as that module's export
        self.assertEqual(set(DECORATOR_MODULE), KNOWN_DECORATORS | OUTSIDE_DECORATORS)
        self.assertEqual(sum(map(len, BINDINGS["modules"].values())), len(DECORATOR_MODULE), "a name has two modules")
        self.assertEqual({name for name, module in DECORATOR_MODULE.items() if module != "@nestjs/common"}, {"Public"})
        self.assertIn(BINDINGS["public_declaration"], self.guard)
        used = Counter()
        for path, source in sorted(sources.items()):
            for name, module in decorator_bindings(path, source, decorator_runs(source)).items():
                used[module] += 1
        self.assertEqual(set(used), set(BINDINGS["modules"]))
        self.assertEqual(used["./auth.guard"], 2, "auth.controller.ts and pacs.controller.ts import Public")
        public_export(sources)
        tags, outside = API / "study-tags.controller.ts", API / "unlisted-routes.ts"
        handler_at = "  @Get() read("
        self.assertEqual(sources[tags].count(handler_at), 1)

        def tagged(imports, handler):
            return imports + sources[tags].replace(handler_at, handler + handler_at)

        reviewed = tagged("import { Get as Header } from '@nestjs/common';\nimport { Public as HttpCode } from './auth.guard';\n",
                          "  @HttpCode() @Header('unlisted') unlisted() { return {}; }\n")
        moved = ("import { Controller as Injectable, Get as Module } from '@nestjs/common';\n@Injectable('unlisted')\n"
                 "export class UnlistedController {\n  @Module('read')\n  read() { return {}; }\n}\n")
        # control: what the readers before this check saw — the controller's handlers and its deciding call text are
        # unchanged, and the outside file carries two classified names and no deciding text, so nothing stopped them
        self.assertEqual([h[:3] for h in controller_handlers(tags, reviewed)], [h[:3] for h in controller_handlers(tags, sources[tags])])
        self.assertEqual([t for _o, t in decorator_text(reviewed)], [t for _o, t in decorator_text(sources[tags])])
        self.assertEqual([name for run in decorator_runs(moved) for name, _s, _e in run["items"]], ["Injectable", "Module"])
        self.assertEqual(decorator_text(moved), [])
        renamed = "an import or export renames a decorator name"
        whole = "a whole-module binding of a module that exports decorators"
        unbound = "is not bound once by import"
        shadowed = "is declared or used outside its import and its uses"
        unread = "an import or export statement the binding check does not read"
        added = API / "bound.controller.ts"
        nest = "import { Controller, Get } from '@nestjs/common';\n"

        def controller(imports, member="  @Get('read')\n  read() { return {}; }\n", before=""):
            return imports + before + "@Controller('bound')\nexport class BoundController {\n" + member + "}\n"

        def service(imports, body=""):
            return imports + body + "@Injectable()\nexport class Helper {\n  run() { return 1; }\n}\n"

        inject = "import { Injectable } from '@nestjs/common';\n"
        # the edits of auth.guard.ts below each change exactly the text they name
        self.assertEqual(sources[API / "auth.guard.ts"].count("  SetMetadata, UnauthorizedException,\n"), 1)
        refused = {
            "reviewer: study-tags Get as Header and Public as HttpCode":
                ({tags: reviewed}, renamed + r": \[\('Get', 'Header'\), \('Public', 'HttpCode'\)\]"),
            "reviewer: unlisted-routes.ts Controller as Injectable, Get as Module":
                ({outside: moved}, renamed + r": \[\('Controller', 'Injectable'\), \('Get', 'Module'\)\]"),
            "study-tags Get as Header alone": ({tags: tagged("import { Get as Header } from '@nestjs/common';\n",
                                                             "  @Header('unlisted') unlisted() { return {}; }\n")},
                                               renamed + r": \[\('Get', 'Header'\)\]"),
            "Public as HttpCode on a real route": ({tags: tagged("import { Public as HttpCode } from './auth.guard';\n",
                                                                 "  @HttpCode() @Get('unlisted') unlisted() { return {}; }\n")},
                                                   renamed + r": \[\('Public', 'HttpCode'\)\]"),
            "an unused route alias": ({added: controller(nest + "import { Post as P } from '@nestjs/common';\n")},
                                      renamed + r": \[\('Post', 'P'\)\]"),
            "another export under a classified name": (
                {added: controller(nest + "import { SetMetadata as Header } from '@nestjs/common';\n",
                                   "  @Header('public', true)\n  @Get('read')\n  read() { return {}; }\n")},
                renamed + r": \[\('SetMetadata', 'Header'\)\]"),
            "a default export under a classified name": ({outside: service(inject + "import { default as Module } from './x';\n")},
                                                        renamed + r": \[\('default', 'Module'\)\]"),
            "a re-export renaming a route": ({outside: service(inject + "export { Get as Header } from '@nestjs/common';\n")},
                                             renamed + r": \[\('Get', 'Header'\)\]"),
            "auth.guard.ts exports Public under another name": (
                {API / "auth.guard.ts": sources[API / "auth.guard.ts"] + "export { Public as Open };\n"},
                renamed + r": \[\('Public', 'Open'\)\]"),
            "namespace import of Nest's common": ({outside: service(inject + "import * as common from '@nestjs/common';\n")}, whole),
            "default import of Nest's common": ({outside: service(inject + "import common from '@nestjs/common';\n")}, whole),
            "import = require of Nest's common": ({outside: service(inject + "import common = require('@nestjs/common');\n")}, whole),
            "namespace import of a part of Nest's common": (
                {outside: service(inject + "import * as parts from '@nestjs/common/decorators';\n")}, whole),
            "export * of the Public module": ({outside: service(inject + "export * from './auth.guard';\n")}, whole),
            "a namespace under a classified name": ({outside: service(inject + "import * as Header from 'node:http';\n")}, whole),
            "a classified name from another module": (
                {added: controller(nest + "import { HttpCode } from './auth.guard';\n",
                                   "  @HttpCode(200)\n  @Get('read')\n  read() { return {}; }\n")},
                r"HttpCode " + unbound + r" \{ HttpCode \} from '@nestjs/common'"),
            "a route from a helper that re-exports it": (
                {added: controller("import { Controller } from '@nestjs/common';\nimport { Get } from './helpers';\n")},
                r"Get " + unbound + r" \{ Get \} from '@nestjs/common'"),
            "Public by a module spelling the check does not resolve": (
                {added: controller(nest + "import { Public } from './auth.guard.js';\n",
                                   "  @Public()\n  @Get('read')\n  read() { return {}; }\n")},
                r"Public " + unbound + r" \{ Public \} from './auth.guard'"),
            "not imported at all": ({outside: service("")}, r"Injectable " + unbound),
            "a type-only import": ({outside: service("import type { Injectable } from '@nestjs/common';\n")}, r"Injectable " + unbound),
            "a type-only specifier": ({outside: service("import { type Injectable } from '@nestjs/common';\n")}, r"Injectable " + unbound),
            "imported twice": ({outside: service(inject + inject)}, r"Injectable " + unbound),
            "destructured from require": ({outside: service("const { Controller: Injectable } = require('@nestjs/common');\n")},
                                          r"Injectable " + unbound),
            "shadowed by a parameter of an enclosing function": (
                {added: nest + "export function make(Get: any) {\n  @Controller('bound')\n  class BoundController {\n"
                               "    @Get('read')\n    read() { return {}; }\n  }\n  return BoundController;\n}\n"},
                r"Get " + shadowed),
            "redeclared in a nested scope": (
                {outside: service(inject, "function wrap() {\n  const Injectable = (path: string) => (target: any) => target;\n"
                                          "  return Injectable;\n}\n")},
                r"Injectable " + shadowed),
            "an escaped identifier": ({added: controller(nest, before="const Head\\u0065r = Get;\n")},
                                      r"an escaped identifier in code"),
            "a string-named specifier": ({added: controller(nest + "import { 'Get' as Header } from '@nestjs/common';\n")},
                                         unread + r" \(a specifier that is not a name\)"),
            "Public declared another way": (
                {API / "auth.guard.ts": sources[API / "auth.guard.ts"].replace(BINDINGS["public_declaration"],
                                                                               "export const Public = () => SetMetadata('open', true);")},
                r"auth\.guard\.ts: Public is not declared once, in code"),
            "Public named again in its module": (
                {API / "auth.guard.ts": sources[API / "auth.guard.ts"] + "export default Public;\n"},
                r"auth\.guard\.ts: Public occurs outside its declaration"),
            "SetMetadata of Public from another module": (
                {API / "auth.guard.ts": sources[API / "auth.guard.ts"].replace("  SetMetadata, UnauthorizedException,\n",
                                                                               "  UnauthorizedException,\n", 1)
                 + "import { SetMetadata } from './clinician-policy';\n"},
                r"auth\.guard\.ts: SetMetadata " + unbound + r" \{ SetMetadata \} from '@nestjs/common'"),
        }
        for label, (files, message) in refused.items():
            with self.subTest(refused=label), self.assertRaisesRegex(AssertionError, message):
                controller_inventory({**sources, **files})
        # the reviewer's outside file stops test_12's reader too
        with self.assertRaisesRegex(AssertionError, renamed):
            outside_decorators(outside, moved)
        # controls: what a correct file looks like still reads, and nothing but the binding decides
        accepted = {
            "a controller importing its names": ({added: controller(nest)}, {("GET", "bound/read"): False}),
            "Public from './auth.guard'": (
                {added: controller(nest + "import { Public } from './auth.guard';\n",
                                   "  @Public()\n  @Get('read')\n  read() { return {}; }\n")}, {("GET", "bound/read"): True}),
            "Public from '../auth.guard' in a subdirectory": (
                {API / "nested" / "bound.controller.ts": controller(nest + "import { Public } from '../auth.guard';\n",
                                                                  "  @Public()\n  @Get('read')\n  read() { return {}; }\n")},
                {("GET", "bound/read"): True}),
            # a route name as a property is refused since S5-U1c-F05 (test_20); a classified name still is not a binding
            "a property named like a classified decorator": (
                {added: controller(nest + "import { Header } from '@nestjs/common';\n",
                                   "  @Header('x-read', '1')\n  @Get('read')\n  read() { return this.Header; }\n")},
                {("GET", "bound/read"): False}),
            # listed packages since S5-U1c-F06: an unlisted one such as node:fs is refused in test_21
            "unrelated aliases and a namespace": (
                {outside: service(inject + "import * as nodeCrypto from 'node:crypto';\nimport { createHash as digest } from 'crypto';\n")},
                {}),
            "a type-only import beside the value import": (
                {outside: service(inject + "import type { Request } from 'express';\n")}, {}),
        }
        for label, (files, extra) in accepted.items():
            with self.subTest(accepted=label):
                found = controller_inventory({**sources, **files})
                self.assertEqual({key: meta["public"] for key, meta in found.items() if key not in baseline}, extra)
                self.assertEqual({key: found[key] for key in baseline}, baseline)
        print("CLINICIAN_POLICY_IMPORT_BINDINGS " + json.dumps({
            "files": len(sources), "bindings_by_module": dict(sorted(used.items())), "refused": sorted(refused),
            "accepted": sorted(accepted), "real_routes": len(baseline), "real_public": len(PUBLIC),
        }, ensure_ascii=True, sort_keys=True))

    def test_20_decorators_applied_without_at_are_refused(self):
        """S5-U1c-F05: decorator_bindings checked only the names the '@' runs carried.

        'import { Put } from '@nestjs/common'' and 'import { Public } from './auth.guard'' in the registered
        study-tags.controller.ts, an undecorated unlisted() and, after the class, 'Put('unlisted')(target, 'unlisted',
        descriptor); Public()(target, 'unlisted', descriptor);' made PUT study-tags/unlisted a public route both
        inventories missed: 110 rows, public 4, test_05/11/12/13 green. Controller, Put and Public called the same way in
        unlisted-routes.ts, registered in AppModule, did the same. A route, Controller, RequestMapping, Public or
        SetMetadata name now occurs in code only as its import and its decorators, and the metadata writers and loaders
        that reach the same metadata under no such name are refused; each refusal is matched by its message.
        """
        sources = api_sources()
        baseline = controller_inventory(sources)
        self.assertEqual(len(baseline), MATRIX["counts"]["routes"])
        self.assertEqual({m + " " + p for (m, p), meta in baseline.items() if meta["public"]}, PUBLIC)
        tags, outside, app = API / "study-tags.controller.ts", API / "unlisted-routes.ts", API / "app.module.ts"
        member, registered = "  @Get() read(", "StudyAccessController],"
        self.assertEqual(sources[tags].count(member), 1)
        self.assertEqual(sources[app].count(registered), 1)
        self.assertTrue(sources[tags].endswith("}\n"))
        applied = ("const target = StudyTagsController.prototype;\n"
                   "const descriptor = Object.getOwnPropertyDescriptor(target, 'unlisted');\n")

        def tagged(imports, calls):
            # the reviewer's shape: imports added, an undecorated member in the registered class, calls after the class
            return imports + sources[tags].replace(member, "  unlisted() { return {}; }\n" + member) + applied + calls

        put, public = "import { Put } from '@nestjs/common';\n", "import { Public } from './auth.guard';\n"
        reviewed = tagged(put + public, "Put('unlisted')(target, 'unlisted', descriptor);\n"
                                        "Public()(target, 'unlisted', descriptor);\n")
        moved = ("import { Controller, Put } from '@nestjs/common';\n" + public
                 + "export class UnlistedController {\n  unlisted() { return {}; }\n}\n"
                   "Controller('unlisted')(UnlistedController);\n"
                   "const target = UnlistedController.prototype;\n"
                   "const descriptor = Object.getOwnPropertyDescriptor(target, 'unlisted');\n"
                   "Put('write')(target, 'unlisted', descriptor);\nPublic()(target, 'unlisted', descriptor);\n")
        app_module = ("import { UnlistedController } from './unlisted-routes';\n"
                      + sources[app].replace(registered, "StudyAccessController, UnlistedController],"))

        def names(source):
            return sorted({name for run in decorator_runs(source) for name, _start, _end in run["items"]})

        # control: what the readers before this check saw — the controller's handlers, its deciding call text and the
        # names its runs carry are unchanged, and the outside file carries no decorator, so nothing stopped either
        self.assertEqual([h[:3] for h in controller_handlers(tags, reviewed)],
                         [h[:3] for h in controller_handlers(tags, sources[tags])])
        self.assertEqual([t for _o, t in decorator_text(reviewed)], [t for _o, t in decorator_text(sources[tags])])
        self.assertEqual(names(reviewed), names(sources[tags]))
        self.assertTrue({"Put", "Public"}.isdisjoint(names(reviewed)))
        self.assertEqual((decorator_runs(moved), decorator_text(moved)), ([], []))
        # control: the same route written as decorators is read, public, and a row test_05 finds missing
        decorated = controller_inventory({**sources, tags: put + public + sources[tags].replace(
            member, "  @Public() @Put('unlisted') unlisted() { return {}; }\n" + member)})
        self.assertEqual({key: meta["public"] for key, meta in decorated.items() if key not in baseline},
                         {("PUT", "study-tags/unlisted"): True})
        self.assertNotIn("PUT study-tags/unlisted", PUBLIC | SESSION | BUSINESS | DENIED_ROUTES)
        undecorated = "used where no decorator the inventory reads applies it"
        writer = "a metadata writer that attaches route or public metadata without a decorator the inventory reads"
        loader = "a module loader the binding check does not follow"
        added = API / "bound.controller.ts"
        nest = "import { Controller, Get } from '@nestjs/common';\n"
        inject = "import { Injectable } from '@nestjs/common';\n"

        def controller(imports, member_text):
            return imports + "@Controller('bound')\nexport class BoundController {\n" + member_text + "}\n"

        def service(imports, after):
            return (imports + "@Injectable()\nexport class Helper {\n  run() { return 1; }\n}\n"
                    "const target = Helper.prototype;\nconst descriptor = Object.getOwnPropertyDescriptor(target, 'run');\n"
                    + after)

        on_read = ("(StudyTagsController.prototype, 'read', "
                   "Object.getOwnPropertyDescriptor(StudyTagsController.prototype, 'read'));\n")
        refused = {
            "reviewer: study-tags Put and Public applied by call":
                ({tags: reviewed}, r"study-tags\.controller\.ts: Public, Put " + undecorated),
            "reviewer: unlisted-routes.ts Controller, Put and Public applied by call, registered in AppModule":
                ({outside: moved, app: app_module}, r"unlisted-routes\.ts: Controller, Public, Put " + undecorated),
            "Put alone applied by call": ({tags: tagged(put, "Put('unlisted')(target, 'unlisted', descriptor);\n")},
                                          r"study-tags\.controller\.ts: Put " + undecorated),
            "Public applied by call to the existing GET study-tags": ({tags: public + sources[tags] + "Public()" + on_read},
                                                                      r"study-tags\.controller\.ts: Public " + undecorated),
            "SetMetadata('public', true) applied by call to the existing GET study-tags": (
                {tags: "import { SetMetadata } from '@nestjs/common';\n" + sources[tags]
                       + "SetMetadata('public', true)" + on_read},
                r"study-tags\.controller\.ts: SetMetadata " + undecorated),
            # a name a run carries already met own_import with its decorators as the uses (S5-U1c-F04), which refuses the
            # call first; the gap was the names no run carries
            "Controller, carried by a run, applied by call to a second class": (
                {tags: sources[tags] + "export class Second {\n  read() { return {}; }\n}\nController('second')(Second);\n"},
                r"study-tags\.controller\.ts: Controller is declared or used outside its import and its uses"),
            "RequestMapping applied by call": (
                {tags: tagged("import { RequestMapping, RequestMethod } from '@nestjs/common';\n",
                              "RequestMapping({ path: 'unlisted', method: RequestMethod.PUT })(target, 'unlisted', "
                              "descriptor);\n")},
                r"study-tags\.controller\.ts: RequestMapping " + undecorated),
            "a route decorator handed to a variable": (
                {tags: tagged(put, "const route = Put;\nroute('unlisted')(target, 'unlisted', descriptor);\n")},
                r"Put " + undecorated),
            "a route decorator in an array": ({tags: tagged(put, "const applied = [Put('unlisted')];\n")},
                                              r"Put " + undecorated),
            "a route decorator in an object": ({tags: tagged(put, "const table = { write: Put };\n")}, r"Put " + undecorated),
            "through applyDecorators": (
                {tags: tagged("import { applyDecorators, Put } from '@nestjs/common';\n",
                              "applyDecorators(Put('unlisted'))(target, 'unlisted', descriptor);\n")},
                r"Put " + undecorated),
            "through Reflect.decorate": (
                {tags: tagged(put, "Reflect.decorate([Put('unlisted')], target, 'unlisted', descriptor);\n")},
                r"Put " + undecorated),
            "a re-export under its own name": ({outside: service(inject, "export { Put } from '@nestjs/common';\n")},
                                               r"unlisted-routes\.ts: Put " + undecorated),
            "a route name as a property of this": (
                {added: controller(nest, "  @Get('read')\n  read() { return this.Get; }\n")},
                r"bound\.controller\.ts: Get " + undecorated),
            "a route name on a module object": (
                {outside: service(inject, "const common = require('@nestjs/common');\n"
                                          "common.Put('x')(target, 'run', descriptor);\n")},
                r"unlisted-routes\.ts: Put " + undecorated),
            "route metadata by Reflect.defineMetadata": (
                {tags: tagged("", "Reflect.defineMetadata('path', 'unlisted', descriptor.value);\n"
                                  "Reflect.defineMetadata('method', 2, descriptor.value);\n")},
                writer + r".*'Reflect\.defineMetadata'"),
            "public metadata by Reflect.metadata": (
                {tags: tagged("", "Reflect.metadata('public', true)(target, 'unlisted', descriptor);\n")},
                writer + r".*'Reflect\.metadata'"),
            "Reflect handed on": ({tags: tagged("", "const R = Reflect;\n")}, writer + r".*'Reflect'\)"),
            "Reflect by a computed member": (
                {tags: tagged("", "Reflect['defineMetadata']('public', true, descriptor.value);\n")},
                writer + r".*'Reflect'\)"),
            "public by Reflector.createDecorator": (
                {outside: service(inject + "import { Reflector } from '@nestjs/core';\n",
                                  "export const Open = Reflector.createDecorator<boolean>({ key: 'public' });\n"
                                  "Open(true)(target, 'run', descriptor);\n")},
                writer + r".*'createDecorator'"),
            "a computed member of a required Nest module": (
                {tags: tagged("", "require('@nestjs/common')['Put']('unlisted')(target, 'unlisted', descriptor);\n")},
                loader + r".*require\('@nestjs/common'\)"),
            "a member loader of a Nest module": (
                {outside: service(inject, "export const common = module.require('@nestjs/common');\n")},
                loader + r".*require\('@nestjs/common'\)"),
            "the Public module by dynamic import": (
                {outside: service(inject, "export const open = async () => (await import('./auth.guard'))['Public'];\n")},
                loader + r".*import\('\./auth\.guard'\)"),
            "the Public module by require with its extension": (
                {outside: service(inject, "export const open = require('./auth.guard.js')['Public'];\n")},
                loader + r".*require\('\./auth\.guard\.js'\)"),
            "a part of Nest's common by a template": (
                {outside: service(inject, "export const parts = require(`@nestjs/common/decorators`);\n")},
                loader + r".*require\('@nestjs/common/decorators'\)"),
            "a module computed at run time": (
                {outside: service(inject, "const name = ['@nestjs', 'common'].join('/');\n"
                                          "export const common = require(name);\n")},
                loader + r".*require\(\) of a module computed at run time"),
            "a template with an expression": (
                {outside: service(inject, "export const common = import(`@nestjs/${'common'}`);\n")},
                loader + r".*import\(\) of a module computed at run time"),
            "require handed on": ({outside: service(inject, "const load = require;\nexport const common = load('x');\n")},
                                  loader + r".*require not called"),
            "Public applied by call in its own module": (
                {GUARD: sources[GUARD] + "Public()(AuthGuard.prototype, 'canActivate', "
                                         "Object.getOwnPropertyDescriptor(AuthGuard.prototype, 'canActivate'));\n"},
                r"auth\.guard\.ts: Public occurs outside its declaration"),
            "a second SetMetadata call in the Public module": (
                {GUARD: sources[GUARD] + "SetMetadata('public', true)(AuthGuard);\n"},
                r"auth\.guard\.ts: SetMetadata is declared or used outside its import and its uses"),
            "SetMetadata as a property in the Public module": (
                {GUARD: sources[GUARD] + "export const open = (globalThis as any).SetMetadata;\n"},
                r"auth\.guard\.ts: SetMetadata is declared or used outside its import and its uses"),
        }
        for label, (files, message) in refused.items():
            with self.subTest(refused=label), self.assertRaisesRegex(AssertionError, message):
                controller_inventory({**sources, **files})
        # the reviewer's outside file stops test_12's reader too
        with self.assertRaisesRegex(AssertionError, r"unlisted-routes\.ts: Controller, Public, Put " + undecorated):
            outside_decorators(outside, moved)
        def plain(imports, after):
            # service() without its target/descriptor lines: reading Helper.prototype is refused since S5-U1c-F06
            return imports + "@Injectable()\nexport class Helper {\n  run() { return 1; }\n}\n" + after

        # controls: an unused import, Reflect's readers, packages loaded by name and a method named require still read
        accepted = {
            "an unused import of a route decorator": {tags: put + sources[tags]},
            "Reflect.ownKeys": {outside: plain(inject, "export const keys = (v: object) => Reflect.ownKeys(v);\n")},
            "a package by require and by import()": {outside: plain(inject, (
                "export const raw = require('express').raw;\n"
                "export const hash = async () => (await import('node:crypto')).createHash('md5');\n"))},
            "a method named require": {outside: inject + "@Injectable()\nexport class Access {\n"
                                                         "  async require(c: any) { return c; }\n"
                                                         "  run() { return this.require(1); }\n}\n"},
        }
        for label, files in accepted.items():
            with self.subTest(accepted=label):
                self.assertEqual(controller_inventory({**sources, **files}), baseline)
        print("CLINICIAN_POLICY_UNDECORATED_USES " + json.dumps({
            "strict_names": sorted(STRICT_NAMES), "refused": sorted(refused), "accepted": sorted(accepted),
            "real_routes": len(baseline), "real_public": len(PUBLIC),
        }, ensure_ascii=True, sort_keys=True))

    def test_21_loaders_and_class_assembly_follow_the_closed_source_contract(self):
        """S5-U1c-F06: module_loads took a loader call by its first string or token and let member calls and calls that
        ':' followed pass, so require('@nest' + 'js/common'), module.require(name), 'true ? require(name) : null' and
        module['require']('@nestjs/common') loaded Nest's common unread, and common['Put'] and common['SetMetadata'],
        strings to the lexer, made PUT study-tags/unlisted a public route both inventories missed: 110 rows, public 4,
        test_05/11/12/13 green, in the registered study-tags.controller.ts and in unlisted-routes.ts registered in
        AppModule. source_contract now lists the forms that reach a loader, an evaluator, a metadata writer or a class
        prototype and every other form is refused; its refused and accepted lists pin the cases below, and each refusal
        is matched by its reasons inside one check's message.
        """
        sources = api_sources()
        baseline = controller_inventory(sources)
        counts = MATRIX["counts"]
        self.assertEqual((len(baseline), counts["public"], counts["session"], counts["business"], counts["denied"]),
                         (116, 4, 2, 11, 99), "the real inventory is unchanged: 116 = 4 + 2 + 11 + 99 (S5-U4a added 6 business rows)")
        self.assertEqual({m + " " + p for (m, p), meta in baseline.items() if meta["public"]}, PUBLIC)
        # the listed packages are exactly what api/src names, the loaded ones exactly what it loads
        named, loaded = set(), set()
        for path, source in sorted(sources.items()):
            named |= {s["module"] for s in module_statements(path, source)
                      if s["module"] is not None and not s["module"].startswith("./")}
            loaded |= set(module_loads(path, source, property_names(path, source)))
        self.assertEqual(sorted(named | loaded), sorted(PACKAGES), "source_contract.packages is what api/src names")
        self.assertEqual(sorted(loaded), sorted(LOADED_PACKAGES), "source_contract.loaded_packages is what api/src loads")

        def reasons_in(message, reasons):
            # each reason is fragments in order inside one check's message, so no other check's text can stand in for it
            parts = message.split(" | ")
            for fragments in reasons:
                pattern = ".*".join(map(re.escape, fragments))
                self.assertTrue(any(re.search(pattern, part) for part in parts), f"{fragments} not in {message}")

        def refusal(files):
            with self.assertRaises(AssertionError) as caught:
                controller_inventory({**sources, **files})
            return str(caught.exception)

        tags, outside, helpers, app = (API / "study-tags.controller.ts", API / "unlisted-routes.ts",
                                       API / "route-helpers.ts", API / "app.module.ts")
        member, registered = "  @Get() read(", "StudyAccessController],"
        heading, constructor = "export class StudyTagsController {", "constructor(private service:StudyTagsService){}"
        for text in (member, heading, constructor):
            self.assertEqual(sources[tags].count(text), 1, text)
        self.assertEqual(sources[app].count(registered), 1)
        self.assertTrue({outside, helpers}.isdisjoint(sources))

        def register(name):
            return {app: f"import {{ {name} }} from './unlisted-routes';\n"
                         + sources[app].replace(registered, f"StudyAccessController, {name}],")}

        loader = "a module loader the binding check does not follow"
        sealed = "a sealed name or a form the source contract does not list"
        undecorated = "used where no decorator the inventory reads applies it"
        # the reviewer's four loaders, each in the registered controller and in an outside file registered in AppModule
        loaders = {
            "concatenated module string": "const common = require('@nest' + 'js/common');\n",
            "module.require of a computed name": "const name = '@nestjs/common';\nconst common = module.require(name);\n",
            "require in a conditional expression": "const name = '@nestjs/common';\nconst common = true ? require(name) : null;\n",
            "module['require'] of Nest's common": "const common = module['require']('@nestjs/common');\n",
        }
        self.assertEqual(sorted(loaders), sorted(CONTRACT["f06_loaders"]))
        applied = ("const target = {0}.prototype;\nconst descriptor = Object.getOwnPropertyDescriptor(target, 'unlisted');\n"
                   "common['Put']('unlisted')(target, 'unlisted', descriptor);\n"
                   "common['SetMetadata']('public', true)(target, 'unlisted', descriptor);\n")
        places = {
            "registered study-tags.controller.ts": (tags, "Put, SetMetadata", "StudyTagsController", lambda text: {
                tags: sources[tags].replace(member, "  unlisted() { return {}; }\n" + member) + text
                      + applied.format("StudyTagsController")}),
            "unlisted-routes.ts registered in AppModule": (outside, "Controller, Put, SetMetadata", "UnlistedController",
                                                           lambda text: {
                outside: "export class UnlistedController {\n  unlisted() { return {}; }\n}\n" + text
                         + "common['Controller']('unlisted')(UnlistedController);\n" + applied.format("UnlistedController"),
                **register("UnlistedController")}),
        }
        f06 = {}
        for form, text in loaders.items():
            why = CONTRACT["f06_loaders"][form]
            for place, (path, names, owner_name, build) in places.items():
                with self.subTest(f06=form, place=place):
                    reasons = [[path.name + ": " + loader, why], [path.name + ": " + names + " " + undecorated],
                               [path.name + ": " + sealed, f"'{owner_name}.prototype')"]]
                    if "module" in text:
                        reasons.append([path.name + ": " + sealed, "'module')"])
                    reasons_in(refusal(build(text)), reasons)
                    f06.setdefault(form, []).append(place)
            # the loader alone, with no route name and no prototype beside it, is refused for itself
            with self.subTest(f06_loader_alone=form):
                message = refusal({outside: text + "export const used = common;\n"})
                reasons_in(message, [[outside.name + ": " + loader, why]])
                self.assertNotIn(undecorated, message)
                self.assertNotIn(".prototype')", message)
        inject = "import { Injectable } from '@nestjs/common';\n"

        def service(after, imports=""):
            return {outside: inject + imports + "@Injectable()\nexport class Helper {\n  run() { return 1; }\n}\n" + after}

        def after_tags(text, imports=""):
            return {tags: imports + sources[tags] + text}

        def edit_tags(old, new, imports="", after=""):
            return {tags: imports + sources[tags].replace(old, new) + after}

        auth = "import { AuthController } from './auth.controller';\n"
        subclass = ("import { StudyTagsController } from './study-tags.controller';\nconst holder: any = {};\n"
                    "export class Unlisted extends StudyTagsController {\n  constructor(service: any) {\n"
                    "    super(service);\n    return holder;\n  }\n}\n")
        refused = {
            # loaders (source_contract.loaded_packages, one plain string literal, the bare callee)
            "import() of a Nest package": service("export const common = import('@nestjs/common');\n"),
            "import() of a concatenated string": service("export const common = import('@nest' + 'js/common');\n"),
            "require of a template naming a loaded package": service("export const raw = require(`express`).raw;\n"),
            "import() of a template naming a loaded package": service("export const hash = import(`node:crypto`);\n"),
            "require of a spread argument": service("export const common = require(...['@nestjs/common']);\n"),
            "require with a second argument": service("export const raw = require('express', 'extra');\n"),
            "a require call followed by a block": service(
                "export function load(name: string) {\n  const found = 1;\n  require(name)\n  {}\n  return found;\n}\n"),
            "an object-literal method named require": service(
                "export const box = { require(name: string) { return name; } };\n"),
            "require on another receiver": service("export const load = (holder: any) => holder.require('express');\n"),
            "require.main": service("export const main = require.main;\n"),
            "require.call": service("export const common = require.call(null, '@nestjs/common');\n"),
            "import.meta": service("export const url = import.meta.url;\n"),
            "import as a member": service("export const load = (holder: any) => holder.import('express');\n"),
            "import = require of a package that is not loaded": service("", "import jose = require('jose');\n"),
            # evaluators and the handles to them (sealed_words, process_members, constructor)
            "eval": service("export const common = eval(\"require('@nestjs/common')\");\n"),
            "new Function": service("export const load = new Function('name', 'return require(name)');\n"),
            "Function called": service("export const self = Function('return this')();\n"),
            "globalThis": service("export const proc = (globalThis as any).process;\n"),
            "global": service("export const proc = (global as any).process;\n"),
            "module.constructor": service("export const load = (module as any).constructor._load;\n"),
            "process.mainModule": service("export const main = process.mainModule;\n"),
            "process.mainModule by a literal key": service("export const main = process['mainModule'];\n"),
            "process handed on": service("export const proc = process;\n"),
            "Proxy": service("export const wrap = (target: any) => new Proxy(target, {});\n"),
            "a constructor as a property": service("export const make = (value: any) => value.constructor.constructor;\n"),
            "a constructor by a literal key": service("export const make = (value: any) => value['constructor'];\n"),
            "Object rebound": service("const Object = { keys: () => [] };\nexport const keys = Object.keys;\n"),
            # modules (source_contract.packages, files under api/src, no whole-module binding of a project file or Nest)
            "createRequire from node:module": service("export const load = createRequire(__filename);\n",
                                                      "import { createRequire } from 'node:module';\n"),
            "runInThisContext from node:vm": service("export const run = runInThisContext;\n",
                                                     "import { runInThisContext } from 'node:vm';\n"),
            "a namespace import of an unlisted package": service("export const read = fs.readFileSync;\n",
                                                                 "import * as fs from 'node:fs';\n"),
            "a side-effect import of an unlisted package": service("", "import 'reflect-metadata';\n"),
            "a relative import outside api/src": service("export const seed = SEED;\n",
                                                         "import { SEED } from '../prisma/seed';\n"),
            "a namespace import of a project file": service("export const service = tags.StudyTagsService;\n",
                                                            "import * as tags from './study-tags.service';\n"),
            "export * of a project file": service("export * from './study-tags.service';\n"),
            "a default import of a Nest package": service("export const nest = core;\n", "import core from '@nestjs/core';\n"),
            # re-export chains: every hop is refused where it names the decorator
            "a named re-export chain to a route decorator": {
                helpers: "export { Put } from '@nestjs/common';\n", outside: "export { Put } from './route-helpers';\n",
                tags: "import { Put } from './unlisted-routes';\n"
                      + sources[tags].replace(member, "  @Put('unlisted') unlisted() { return {}; }\n" + member)},
            "a star re-export chain to Public": {helpers: "export { Public } from './auth.guard';\n",
                                                 outside: "export * from './route-helpers';\n"},
            # class assembly: a registered class's instance carries only the route methods its own class body declares
            "Object.assign onto a controller prototype": after_tags(
                "Object.assign(StudyTagsController.prototype, { unlisted: AuthController.prototype.login });\n", auth),
            "Object.assign onto the prototype of this": edit_tags(
                constructor, constructor + "\n  private readonly mixed = Object.assign(Object.getPrototypeOf(this), holder);",
                after="const holder: any = {};\n"),
            "defineProperty onto a controller prototype": after_tags(
                "Object.defineProperty(StudyTagsController.prototype, 'unlisted', { value: () => ({}) });\n"),
            "setPrototypeOf of a controller prototype": after_tags(
                "Object.setPrototypeOf(StudyTagsController.prototype, {});\n"),
            "__proto__ in an object literal": service("export const donor = { __proto__: { run() { return 1; } } };\n"),
            "a controller that extends another class": edit_tags(
                heading, "export class StudyTagsController extends AuthController {", auth),
            "a class expression that extends in a controller file": after_tags(
                "export const Mixed = class extends StudyTagsController {};\n"),
            "a controller constructor that returns another object": edit_tags(
                constructor, "constructor(private service:StudyTagsService){ return holder; }", after="const holder: any = {};\n"),
            "a registered subclass whose constructor returns another object": {outside: subclass, **register("Unlisted")},
            # metadata writers (reflect_members; defineMetadata, decorate, createDecorator under any name or key)
            "Reflect.set": service("export const put = (holder: any) => Reflect.set(holder, 'x', 1);\n"),
            "Reflect.defineProperty": service("export const put = (holder: any) => Reflect.defineProperty(holder, 'x', {});\n"),
            "Reflect.construct": service("export const make = (target: any) => Reflect.construct(target, []);\n"),
            "Reflect cast to any": service(
                "export const write = (holder: any) => (Reflect as any).defineMetadata('public', true, holder);\n"),
            "defineMetadata by a literal key": service(
                "export const write = (holder: any) => holder['defineMetadata']('public', true, holder);\n"),
            "Reflect by a literal key": service("export const write = (holder: any) => holder['Reflect'];\n"),
            # literal keys are read as the member they name
            "a route name by a literal key": service("export const put = (holder: any) => holder['Put'];\n"),
            "a route name by a template key": service("export const put = (holder: any) => holder[`Put`];\n"),
            "an escaped property key": service("export const put = (holder: any) => holder['P" + "\\u" + "0075t'];\n"),
            "require by an optional literal key": service("export const load = (holder: any) => holder?.['require']('express');\n"),
            # a string that spells a handle is read wherever it stands but in an array literal
            "a quoted __proto__ key": service("export const donor = { '__proto__': { run() { return 1; } } };\n"),
            "a quoted constructor that returns another object": {outside: subclass.replace(
                "  constructor(service: any) {", "  'constructor'(service: any) {"), **register("Unlisted")},
            "prototype by a string argument": after_tags(
                "Object.assign(Object.getOwnPropertyDescriptor(StudyTagsController, 'prototype')!.value, { unlisted: () => ({}) });\n"),
            "a handle spread from an array into a call": after_tags(
                "export const proto = Object.getOwnPropertyDescriptor(StudyTagsController, ...['prototype', 'x']);\n"),
            "createDecorator by a string argument": service(
                "export const Open = Object.getOwnPropertyDescriptor(Reflector, 'createDecorator')!.value({ key: 'public' });\n",
                "import { Reflector } from '@nestjs/core';\n"),
            "Object declared as a generic function": service("export function Object<T>(value: T) { return value; }\n"),
        }
        self.assertEqual(sorted(refused), sorted(CONTRACT["refused"]), "source_contract.refused pins exactly these cases")
        for label, files in refused.items():
            with self.subTest(refused=label):
                reasons_in(refusal(files), CONTRACT["refused"][label])
        # controls: the listed forms still read, and a subclass outside the controllers is read as the routes it serves
        accepted = {
            "this.require and this.<field>.require of a method named require": {outside: inject + (
                "@Injectable()\nexport class Access {\n  constructor(private studyAccess: any) {}\n"
                "  async require(c: any) { return c; }\n"
                "  run(c: any) { return this.studyAccess.require(c, ['uid']) && this.require(c); }\n}\n")},
            "a method named require with a return type": {outside: inject + (
                "@Injectable()\nexport class Access {\n  async require(c: any): Promise<any> { return c; }\n}\n")},
            "Object.assign on data and a compared prototype": service(
                "export const merge = (row: any) => Object.getPrototypeOf(row) === Object.prototype "
                "&& Object.assign(row, { seen: true });\n"),
            "Array and Object as members, a type and new Array()": service(
                "export const list = (value: any): Array<number> => Array.isArray(value) && Object.getPrototypeOf(value) "
                "!== Array.prototype ? new Array(value.length) : Object.keys(value).map(Number);\n"),
            "process.env and process.exit": service("export const port = () => process.env.PORT ?? process.exit(1);\n"),
            "Reflect.ownKeys and a namespace of a listed package": service(
                "export const keys = (v: object) => Reflect.ownKeys(v).length + nodeCrypto.randomBytes(1).length;\n",
                "import * as nodeCrypto from 'node:crypto';\n"),
            "one-literal keys that name nothing sealed": service(
                "export const pick = (headers: any) => headers['content-type'] ?? headers['accept'] ?? headers[`x-kin`] "
                "?? ['reason'];\n"),
            "a registered subclass of a controller without a constructor": {outside: (
                "import { StudyTagsController } from './study-tags.controller';\n"
                "export class Mirror extends StudyTagsController {}\n"), **register("Mirror")},
            "a class outside the controllers that extends Error": service(
                "export class LocalError extends Error {\n  constructor(message: string) {\n    super(message);\n  }\n}\n"),
            "handle names as elements of an array literal": service(
                "export const reserved = new Set(['prototype', 'constructor', '__proto__', ...Object.keys({})]);\n"),
        }
        self.assertEqual(sorted(accepted), sorted(CONTRACT["accepted"]), "source_contract.accepted pins exactly these")
        for label, files in accepted.items():
            with self.subTest(accepted=label):
                self.assertEqual(controller_inventory({**sources, **files}), baseline)
        print("CLINICIAN_POLICY_SOURCE_CONTRACT " + json.dumps({
            "f06_refused": f06, "refused": sorted(refused), "accepted": sorted(accepted), "packages": sorted(PACKAGES),
            "loaded_packages": sorted(LOADED_PACKAGES), "sealed_words": sorted(CONTRACT["sealed_words"]),
            "real_routes": len(baseline), "real_public": len(PUBLIC),
        }, ensure_ascii=True, sort_keys=True))

    def test_22_regex_and_division_are_told_apart_by_the_token_before(self):
        """S5-U1c-F07: code_mask decided a '/' by the one character before it, and '+', '-' and '}' opened a regex.

        After the registered StudyTagsController, 'let probe = 1; probe++ / (() => { const t =
        StudyTagsController.prototype; Reflect.defineMetadata('path', 'unlisted', t.unlisted); ... return 1; })() / 1;'
        was a regex from the first '/' to the second, so the metadata writes that make PUT study-tags/unlisted a public
        route were blank to every check: 110 rows, public 4, test_05/11/12/13 green. 'probe--' and '<any>{}' before the
        '/' did the same, and so did unlisted-routes.ts registered in AppModule; 'probe++ / require(...) / 1' hid a
        loader. Each token now says what a '/' after it is, a reading that turns on grammar the lexer does not track
        refuses the source, and a regex literal spells no checked name; each refusal is matched by its reasons inside
        one check's message.
        """
        sources = api_sources()
        baseline = controller_inventory(sources)
        counts = MATRIX["counts"]
        self.assertEqual((len(baseline), counts["public"], counts["session"], counts["business"], counts["denied"]),
                         (116, 4, 2, 11, 99), "the real inventory is unchanged: 116 = 4 + 2 + 11 + 99 (S5-U4a added 6 business rows)")
        contract = CONTRACT["regex_or_division"]
        self.assertEqual((sorted(OPERAND_WORDS), sorted(UNREAD_WORDS), sorted(CONTROL_WORDS), sorted(OPERAND_PUNCT),
                          sorted(UNREAD_PUNCT)),
                         (contract["operand_words"], contract["unread_words"], contract["control_words"],
                          contract["operand_punct"], contract["unread_punct"]), "the rule tables are the contract's")
        unread = "a '/' the lexer does not read as a regex or a division from the token before it"

        def reading(source):
            return " ".join(code_mask(source).split())

        # what code_mask leaves of each source: every '/' of a division stays code, a regex literal is blank
        divisions = {
            "after a name, a number and a literal": ("x / 2 / 'a' / `b` / 1. / .5 / 1e3;\n", "x / 2 / / / 1. / .5 / 1e3;"),
            "after the ')' of a call or a group and after ']'": ("f(x) / (a + b) / xs[0] / [1][0];\n",
                                                                "f(x) / (a + b) / xs[0] / [1][0];"),
            "after a postfix '++' and '--'": ("i++ / j-- / 2;\n", "i++ / j-- / 2;"),
            "after a non-null assertion": ("x! / y.z! / 2;\n", "x! / y.z! / 2;"),
            "after a keyword that is a property or a private name": ("x.return / x?.delete / this.#in / 2;\n",
                                                                     "x.return / x?.delete / this.#in / 2;"),
            "after this, null and true": ("this / null / true / 2;\n", "this / null / true / 2;"),
            "in a template substitution": ("`${n / 2}`;\n", "n / 2 ;"),
            "the reviewer's postfix increment": ("probe++ / (() => { return 1; })() / 1;\n",
                                                 "probe++ / (() => { return 1; })() / 1;"),
        }
        regexes = {
            "at the start and after an operator": ("/a/.test(s) + /b/.test(s) - /c/.test(s);\n",
                                                   ".test(s) + .test(s) - .test(s);"),
            "after '(', ',', '[', '?', ':', '=' and '=>'": ("f(/a/, [/b/], c ? /d/ : /e/); g = (s) => /f/;\n",
                                                            "f( , [ ], c ? : ); g = (s) => ;"),
            "after a prefix '!'": ("if (!/a/.test(s)) {}\n", "if (! .test(s)) {}"),
            "after an operand keyword": ("return typeof /a/ in /b/;\n", "return typeof in ;"),
            "after the ')' of an if, while, for and for await header": (
                "if (s) /'/.test(s);\nwhile (s) /\"/.test(s);\nfor (;;) /`/.test(s);\nfor await (const x of y) /a/.test(x);\n",
                "if (s) .test(s); while (s) .test(s); for (;;) .test(s); for await (const x of y) .test(x);"),
            "after else, do and case": ("if (a) {} else /a/.test(s);\ndo /b/.test(s); while (a);\n"
                                        "switch (a) { case /c/.source: }\n",
                                        "if (a) {} else .test(s); do .test(s); while (a); switch (a) { case .source: }"),
            "after '...' and in a template substitution": ("[.../a/.source, `${/b/.source}`];\n", "[... .source, .source ];"),
            "after a prefix '++' and after a division": ("++/a/.lastIndex; x = y / /b/.source.length;\n",
                                                         "++ .lastIndex; x = y / .source.length;"),
        }
        refused_readings = {
            "after the '}' of an object expression": "const probe = <any>{} / 2 / 1;\n",
            "after the '}' of a block": "{}\n/a/.test(s);\n",
            "after the '>' of type arguments": "const g = f<string> / 2;\n",
            "after 'of'": "for (const x of /a/.exec(s)) {}\n",
            "after 'await'": "async function f(s: string) { return await /a/.test(s); }\n",
            "after 'yield'": "function* g() { yield /a/; }\n",
            "after 'void' as a type": "(x as any) satisfies void / 2;\n",
            "at the start of a line after a type annotation": "let x: Foo\n/'/.test(s);\n",
            "after a comment that holds a line terminator": "a /* \u2028 */ / 2;\n",
            "after a '++' that follows '}'": "{}++ / 2;\n",
            "after '.'": "a./b/;\n",
            "a hashbang": "#!/usr/bin/env node\n",
        }
        for label, (source, expected) in divisions.items():
            with self.subTest(division=label):
                self.assertEqual(reading(source), expected)
                self.assertEqual(lexed(source)[2], ())
        for label, (source, expected) in regexes.items():
            with self.subTest(regex=label):
                self.assertEqual(reading(source), expected)
                self.assertTrue(lexed(source)[2])
        for label, source in refused_readings.items():
            with self.subTest(refused_reading=label), self.assertRaisesRegex(
                    AssertionError, re.escape(unread) + ".*" + re.escape(contract["readings"]["refused"][label])):
                code_mask(source)
        self.assertEqual((sorted(divisions), sorted(regexes), sorted(refused_readings)),
                         (contract["readings"]["division"], contract["readings"]["regex"],
                          sorted(contract["readings"]["refused"])), "readings pins exactly these cases")

        def reasons_in(message, reasons, replace):
            parts = message.split(" | ")
            for fragments in reasons:
                fragments = [functools.reduce(lambda text, pair: text.replace(*pair), replace.items(), fragment)
                             for fragment in fragments]
                pattern = ".*".join(map(re.escape, fragments))
                self.assertTrue(any(re.search(pattern, part) for part in parts), f"{fragments} not in {message}")

        def refusal(files):
            with self.assertRaises(AssertionError) as caught:
                controller_inventory({**sources, **files})
            return str(caught.exception)

        tags, outside, app = API / "study-tags.controller.ts", API / "unlisted-routes.ts", API / "app.module.ts"
        member, registered = "  @Get() read(", "StudyAccessController],"
        self.assertEqual(sources[tags].count(member), 1)
        self.assertEqual(sources[app].count(registered), 1)
        self.assertNotIn(outside, sources)
        writes = ("(() => { {class_path}const t = {class}.prototype; Reflect.defineMetadata('path', 'unlisted', t.unlisted); "
                  "Reflect.defineMetadata('method', 2, t.unlisted); Reflect.defineMetadata('public', true, t.unlisted); "
                  "return 1; })()")
        forms = {
            "postfix ++": "let probe = 1; probe++ / WRITES / 1;\n",
            "postfix --": "let probe = 1; probe-- / WRITES / 1;\n",
            "an object expression": "const probe = <any>{} / WRITES / 1;\n",
            "the loader alone": "let probe = 1; probe++ / require('@nestjs\\x2fcommon') / 1;\n",
        }
        self.assertEqual(sorted(forms), sorted(contract["forms"]))
        # the reviewer's text in the registered controller; in the outside file the class gets its prefix the same way
        places = {
            "registered study-tags.controller.ts": (tags, "StudyTagsController", "", lambda text: {
                tags: sources[tags].replace(member, "  unlisted() { return {}; }\n" + member) + text}),
            "unlisted-routes.ts registered in AppModule": (
                outside, "UnlistedController", "Reflect.defineMetadata('path', 'unlisted', UnlistedController); ",
                lambda text: {outside: "export class UnlistedController {\n  unlisted() { return {}; }\n}\n" + text,
                              app: "import { UnlistedController } from './unlisted-routes';\n"
                                   + sources[app].replace(registered, "StudyAccessController, UnlistedController],")}),
        }
        self.assertEqual(sorted(places), sorted(contract["places"]))
        # control: the reader at e33e040 opened a regex after '(,=:[!&|?{};+-*%<>~^', and each form puts '+', '-' or '}'
        # right before its first '/'
        previous = frozenset("(,=:[!&|?{};+-*%<>~^")
        f07 = {}
        for form, text in forms.items():
            for place, (path, owner_name, class_path, build) in places.items():
                source = text.replace("WRITES", writes.replace("{class_path}", class_path).replace("{class}", owner_name))
                with self.subTest(f07=form, place=place):
                    self.assertIn(source[:source.index("/")].rstrip()[-1], previous)
                    message = refusal(build(source))
                    reasons_in(message, contract["forms"][form], {"{file}": path.name, "{class}": owner_name})
                    if form != "an object expression":
                        # the '/' divides, so what stands between the two is code every check reads
                        self.assertNotIn(unread, message)
                        self.assertIn("require(" if form == "the loader alone" else "Reflect.defineMetadata",
                                      code_mask(source))
                    f07.setdefault(form, []).append(place)
        inject = "import { Injectable } from '@nestjs/common';\n"
        helper = inject + "@Injectable()\nexport class Helper {\n  run() { return 1; }\n}\n"
        refused = {
            "a regex literal that spells checked names": {outside: helper + "export const pattern = /Reflect\\.defineMetadata|require/;\n"},
        }
        self.assertEqual(sorted(refused), sorted(contract["refused"]))
        for label, files in refused.items():
            with self.subTest(refused=label):
                reasons_in(refusal(files), contract["refused"][label], {"{file}": outside.name})
        # controls: divisions and regex literals of every supported kind in one file read unchanged, including a regex
        # after an if header whose quote the reader before this opened as a string
        accepted = {
            "divisions after names, calls, indexes, postfix operators and non-null assertions": {outside: helper + (
                "export const ratio = (a: number, b: number) => a / b / (a + b) / [a][0];\n"
                "export const next = (n: number) => { let i = n; i++; i--; return i++ / 2 + i-- / n! / 2; };\n")},
            "regex literals after operators, '!', a control header and in a template": {outside: helper + (
                "export const slug = (s: string) => s.replace(/[^a-z0-9]+/g, '-').split('/').length / 2;\n"
                "export const label = (n: number) => `${n / 2}/${/x/.source}`;\n"
                "export const check = (s: string) => { if (s) /'/.test(s); return !/\"/.test(s) && typeof /`/ === 'object'; };\n")},
        }
        self.assertEqual(sorted(accepted), sorted(contract["accepted"]))
        for label, files in accepted.items():
            with self.subTest(accepted=label):
                self.assertEqual(controller_inventory({**sources, **files}), baseline)
        print("CLINICIAN_POLICY_REGEX_OR_DIVISION " + json.dumps({
            "f07_refused": f07, "division": sorted(divisions), "regex": sorted(regexes),
            "refused_readings": sorted(refused_readings), "refused": sorted(refused), "accepted": sorted(accepted),
            "real_routes": len(baseline), "real_public": len(PUBLIC),
        }, ensure_ascii=True, sort_keys=True))

    def test_23_class_headings_are_read_past_type_parameters(self):
        """S5-U1c-F08: controller_heritage took the first '{' after 'class' for the class body.

        api/src/review-inherited.controller.ts holding '@Controller('unlisted') export class ReviewInheritedController<T =
        {}> extends PacsController {}', registered in AppModule, ended its heading at the generic default's type literal,
        so the extends after it went unread and GET unlisted/health, PacsController's @Public() under this prefix, stayed
        out of every inventory: 110 rows, public 4, test_05/11/12/13/21/22 green. '<T = { marker: string }>' and '<T = () => {
        marker: string }>' did the same. class_heading reads every heading to the '{' of its body and class_body reads the
        same heading; each refusal is matched by its reasons inside one check's message, and test_05 itself runs with each
        of the reviewer's forms in place of api/src.
        """
        sources = api_sources()
        baseline = controller_inventory(sources)
        counts = MATRIX["counts"]
        self.assertEqual((len(baseline), counts["public"], counts["session"], counts["business"], counts["denied"]),
                         (116, 4, 2, 11, 99), "the real inventory is unchanged: 116 = 4 + 2 + 11 + 99 (S5-U4a added 6 business rows)")
        contract = CONTRACT["class_heading"]
        # every class keyword of api/src has a heading class_heading reads, and no controller file's class extends
        keywords, extending = 0, set()
        for path, source in sorted(sources.items()):
            code = code_mask(source)
            for at in class_keywords(code):
                keywords += 1
                heading = class_heading(code, at)
                self.assertIn(heading["body"], class_bodies(code))
                if heading["extends"]:
                    extending.add(path.name)
        self.assertTrue(extending)
        self.assertEqual([name for name in extending if name.endswith(".controller.ts")], [])

        def old_class_body(code, brace):
            # the class_body before this: the word class in the text since the ';', '{' or '}' before the brace
            start = max(code.rfind(";", 0, brace), code.rfind("{", 0, brace), code.rfind("}", 0, brace)) + 1
            return CLASS_WORD.search(code, start, brace) is not None

        def reasons_in(message, reasons):
            # each reason is fragments in order inside one check's message, so no other check's text can stand in for it
            parts = message.split(" | ")
            for fragments in reasons:
                pattern = ".*".join(map(re.escape, fragments))
                self.assertTrue(any(re.search(pattern, part) for part in parts), f"{fragments} not in {message}")

        def refusal(files):
            with self.assertRaises(AssertionError) as caught:
                controller_inventory({**sources, **files})
            return str(caught.exception)

        added, outside, app = API / "review-inherited.controller.ts", API / "unlisted-routes.ts", API / "app.module.ts"
        registered = "controllers: [DictationController,"
        self.assertEqual(sources[app].count(registered), 1)
        self.assertTrue({added, outside}.isdisjoint(sources))

        def controller(heading, before="", body="", inherits=True):
            # the reviewer's file, registered in AppModule's controllers before DictationController as the review did
            text = ("import { Controller } from '@nestjs/common';\n"
                    + ("import { PacsController } from './pacs.controller';\n" if inherits else "") + before
                    + "@Controller('unlisted')\nexport " + heading + " {" + body + "}\n")
            return {added: text, app: "import { ReviewInheritedController } from './review-inherited.controller';\n"
                                      + sources[app].replace(registered, "controllers: [ReviewInheritedController, "
                                                                         "DictationController,")}

        forms = {
            "<T = {}>": controller("class ReviewInheritedController<T = {}> extends PacsController"),
            "<T = { marker: string }>": controller(
                "class ReviewInheritedController<T = { marker: string }> extends PacsController"),
            "<T = () => { marker: string }>": controller(
                "class ReviewInheritedController<T = () => { marker: string }> extends PacsController"),
        }
        control = {"the same inheritance without a generic": controller(
            "class ReviewInheritedController extends PacsController")}
        self.assertEqual((sorted(forms), sorted(control)), (sorted(contract["forms"]), sorted(contract["control"])))
        pinned = {**contract["forms"], **contract["control"]}
        test_05 = self.test_05_every_route_has_exactly_one_matrix_row_and_the_counts_reconcile
        f08 = {}
        for label, files in {**forms, **control}.items():
            with self.subTest(f08=label):
                code = code_mask(files[added])
                at = class_keywords(code)
                self.assertEqual(len(at), 1)
                self.assertEqual(len(class_heading(code, at[0])["extends"]), 1)
                # control: the heading before this ran to the first '{', the generic default's, and so held no extends
                self.assertEqual(EXTENDS_WORD.search(code, at[0], code.find("{", at[0])) is not None, label in control)
                reasons_in(refusal(files), pinned[label])
                # test_05 itself with the file set in place of api/src stops at the refusal instead of passing
                with mock.patch.object(sys.modules[__name__], "api_sources",
                                       lambda root=API, files=files: {**sources, **files}):
                    with self.assertRaises(AssertionError) as caught:
                        test_05()
                reasons_in(str(caught.exception), pinned[label])
                f08[label] = ["controller_inventory", "test_05"]
        # a generic controller is read like any other: its own route is a row test_05 finds missing
        routed = controller("class ReviewInheritedController<T = () => { marker: string }>",
                            "import { Get } from '@nestjs/common';\n", "\n  @Get('read')\n  read() { return {}; }\n",
                            inherits=False)
        found = controller_inventory({**sources, **routed})
        self.assertEqual(sorted(set(found) - set(baseline)), [("GET", "unlisted/read")])
        self.assertFalse(found[("GET", "unlisted/read")]["public"])
        with mock.patch.object(sys.modules[__name__], "api_sources", lambda root=API: {**sources, **routed}):
            with self.assertRaisesRegex(AssertionError, "controller routes without a route_matrix row"):
                test_05()
        inject = "import { Injectable } from '@nestjs/common';\n"
        helper = inject + "@Injectable()\nexport class Helper {\n  run() { return 1; }\n}\n"
        refused = {
            "an abstract generic class that extends": controller(
                "abstract class ReviewInheritedController<T = {}> extends PacsController"),
            # registered only by a default import, which decorator_bindings refuses in app.module.ts for itself
            "a default-exported generic class that extends": {
                added: controller("default class<T = {}> extends PacsController")[added]},
            "an implements clause with a type literal before extends": controller(
                "class ReviewInheritedController implements Marker<{ marker: string }> extends PacsController",
                "interface Marker<T> { marker?: T }\n"),
            "a type parameter constraint": controller("class ReviewInheritedController<T extends object = {}>",
                                                      inherits=False),
            "a '<' that does not close": controller("class ReviewInheritedController<T = {} extends PacsController"),
            "a token no type holds inside '<' and '>'": controller("class ReviewInheritedController<T = PacsController!>"),
            "class as an object key in a controller file": controller(
                "class ReviewInheritedController", "export const keys = { class: 1 };\n", inherits=False),
            "a member named class in a controller file": controller(
                "class ReviewInheritedController", body="\n  class() { return 1; }\n", inherits=False),
            "a loader call in a block after 'x. class'": {
                outside: helper + "const x: any = {};\nif (x. class) {\n  require('../outside')\n  {}\n}\n"},
        }
        self.assertEqual(sorted(refused), sorted(contract["refused"]), "class_heading.refused pins exactly these cases")
        for label, files in refused.items():
            with self.subTest(refused=label):
                reasons_in(refusal(files), contract["refused"][label])
        # control: the class_body before this took the if block for a class body, so the loader call in it, a block
        # after it, passed as a method declaration
        code = code_mask(refused["a loader call in a block after 'x. class'"][outside])
        block = code.index("{", code.index("x. class"))
        self.assertTrue(old_class_body(code, block))
        self.assertFalse(class_body(code, block))
        accepted = {
            "a generic controller without inheritance": controller(
                "class ReviewInheritedController<T = { marker: string }>", inherits=False),
            "a require method in a class whose generic default holds a type literal": {outside: inject + (
                "@Injectable()\nexport class Access<T = { marker: string }> {\n  async require(c: any) { return c; }\n"
                "  run() { return this.require(1); }\n}\n")},
            "class as a property name after '.' and '?.' in a controller file": controller(
                "class ReviewInheritedController", "export const flag = (x: any) => x. class ?? x?. class;\n",
                inherits=False),
        }
        self.assertEqual(sorted(accepted), sorted(contract["accepted"]), "class_heading.accepted pins exactly these")
        for label, files in accepted.items():
            with self.subTest(accepted=label):
                self.assertEqual(controller_inventory({**sources, **files}), baseline)
        # control: the class_body before this found no class body there, so that require method was read as a loader call
        code = code_mask(accepted["a require method in a class whose generic default holds a type literal"][outside])
        body = class_heading(code, code.index("class Access"))["body"]
        self.assertFalse(old_class_body(code, body))
        self.assertTrue(class_body(code, body))
        print("CLINICIAN_POLICY_CLASS_HEADING " + json.dumps({
            "f08_refused": f08, "refused": sorted(refused), "accepted": sorted(accepted), "class_keywords": keywords,
            "extending_outside_controllers": sorted(extending), "real_routes": len(baseline), "real_public": len(PUBLIC),
        }, ensure_ascii=True, sort_keys=True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
