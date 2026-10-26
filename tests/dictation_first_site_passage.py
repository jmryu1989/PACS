# coding: utf-8
"""The synthetic passage the first-site dictation run speaks (tests/e2e/test_dictation_first_site.py).

Deterministic, non-clinical and stdlib only: the same sentences every run, built from fixed word lists, so
a transcript can be scored sentence by sentence and the last sentences show whether the end of a long
recording reached the engine. eSpeak NG (the pinned generator image of tests/fixtures/asr) speaks it on the
heavy host; there is no recorded human speech, no patient data and no clinical text here.

What a score here means: the chain kept the whole recording and the pinned engine recognised clear
synthetic English. It says nothing about a radiologist's real speech, accent, vocabulary or room.
"""
import re

COLORS = ('red', 'blue', 'green', 'yellow', 'orange', 'purple', 'black', 'white', 'brown', 'gray', 'pink')
SHAPES = ('circle', 'square', 'triangle', 'star', 'cube', 'sphere', 'cone', 'ring', 'arrow', 'diamond', 'heart')
RELATIONS = ('next to', 'above', 'below', 'behind', 'inside', 'beside', 'near', 'under', 'over')
COUNT = 40


def sentences(count=COUNT):
    out = []
    for i in range(count):
        out.append('The %s %s is %s the %s %s.' % (
            COLORS[i % len(COLORS)], SHAPES[(i * 5) % len(SHAPES)], RELATIONS[(i * 4) % len(RELATIONS)],
            COLORS[(i * 7 + 3) % len(COLORS)], SHAPES[(i * 3 + 2) % len(SHAPES)]))
    return out


def text(count=COUNT):
    """What eSpeak reads: one sentence per line."""
    return '\n'.join(sentences(count)) + '\n'


def words(value):
    return re.findall(r'[a-z]+', value.lower())


def score(transcript, count=COUNT, tail=8):
    """Sentence-level exact recognition (every word, in order, case and punctuation aside), and the same for
    the last `tail` sentences of the passage. A recording that kept only its first minute cannot reach them."""
    heard = ' ' + ' '.join(words(transcript)) + ' '
    found = [index for index, sentence in enumerate(sentences(count)) if ' ' + ' '.join(words(sentence)) + ' ' in heard]
    return {'sentences': count, 'recognised': len(found), 'recognised_indexes': found,
            'tail': tail, 'tail_recognised': sum(1 for index in found if index >= count - tail),
            'transcript_words': len(words(transcript))}
