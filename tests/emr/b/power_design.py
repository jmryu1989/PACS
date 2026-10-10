"""REQ-D956 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT -> prospective single power.

Standard-library empirical bootstrap, NOT acceptance evidence. A beta order
statistic samples the exact nearest-rank p95 of n iid empirical draws without
allocating n requests. Whole paired blocks remain the units of the t bound.
Pooled and paired-block mixture models are both reported; their agreement is
not a guarantee about unobserved host regimes or future drift.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics

from noninferiority import T95, log_ratio_bound


def empirical_quantile(population, size, rng):
    rank = math.ceil(.95 * size)
    u = rng.betavariate(rank, size + 1 - rank)
    return population[min(len(population) - 1, int(u * len(population)))]


def single_probability(samples, size, blocks, *, replicates=20000, seed=956, model='pooled'):
    if model not in ('pooled', 'paired-block-mixture') or not 2 <= blocks <= 31 or size < 2:
        raise ValueError('unsupported prospective design')
    if len(samples['r3']) != len(samples['candidate']):
        raise ValueError('paired historical blocks required')
    pairs = [(sorted(a), sorted(b)) for a, b in zip(samples['r3'], samples['candidate'])]
    if model == 'pooled':
        pairs = [(sorted(sum(samples['r3'], [])), sorted(sum(samples['candidate'], [])))]
    if any(not a or not b or any(not math.isfinite(x) or x <= 0 for x in a + b) for a, b in pairs):
        raise ValueError('positive finite populations required')
    pools = [sorted(a + b) for a, b in pairs]
    rng = random.Random(seed)
    # Independent draw bank per scenario. At equality BOTH arms are sampled
    # from the same empirical distribution, not a shifted noisy observed ratio.
    banks = {'at_equality': [], 'at_observed': []}
    for _ in range(20000):
        i = rng.randrange(len(pairs))
        a, b = pairs[i]
        q = lambda p: empirical_quantile(p, size, rng)
        banks['at_equality'].append(math.log(q(pools[i]) / q(pools[i])))
        banks['at_observed'].append(math.log(q(b) / q(a)))
    answer = {}
    for name, values in banks.items():
        accepted = 0
        for _ in range(replicates):
            logs = rng.choices(values, k=blocks)
            mean = sum(logs) / blocks
            sd = math.sqrt(sum((x - mean) ** 2 for x in logs) / (blocks - 1))
            accepted += mean <= math.log(1.10) and mean + T95[blocks - 1] * sd / math.sqrt(blocks) <= math.log(1.10)
        p = accepted / replicates
        answer[name] = p
        answer[name + '_monte_carlo_se'] = math.sqrt(p * (1 - p) / replicates)
        answer[name + '_block_log_sd'] = statistics.stdev(values)
        answer[name + '_block_point'] = math.exp(statistics.mean(values))
    return {**answer, 'model': model, 'blocks': blocks, 'requests_per_block': size,
            'seed': seed, 'replicates': replicates, 'bank_size': 20000,
            'target_met': answer['at_equality'] >= .80,
            'scope': 'single point<=1.10 AND paired log-ratio one-sided t upper bound<=1.10',
            'conditioning': 'quiet-host, functional, JIT and attribution validity; no future regime shift'}


def self_check():
    rng = random.Random(1956)
    # For n=2, p95=max. P(max of two fair {1,2} draws = 1) = 1/4.
    low = sum(empirical_quantile([1., 2.], 2, rng) == 1 for _ in range(20000)) / 20000
    assert .24 < low < .26, low
    same = {'r3': [[100.] * 40] * 3, 'candidate': [[100.] * 40] * 3}
    flat = single_probability(same, 120, 10, replicates=1000)
    assert flat['at_equality'] == flat['at_observed'] == 1
    bad = {**same, 'candidate': [[111.] * 40] * 3}
    assert single_probability(bad, 120, 10, replicates=1000)['at_observed'] == 0
    # Independent check of the actual t rule used by the simulation.
    for logs in [[-.1, 0, .1], [0.] * 10, [.1] * 30]:
        n = len(logs)
        mean = sum(logs) / n
        sd = math.sqrt(sum((x - mean) ** 2 for x in logs) / (n - 1))
        assert abs(math.exp(mean + T95[n - 1] * sd / math.sqrt(n)) - log_ratio_bound(logs)['upper_95_ratio']) < 1e-12
    return {'passed': True, 'exact_order_statistic_control': low,
            'constant_equality_and_over_margin_controls': True, 'actual_t_rule_control': True}


def design(paths, designs, replicates=20000):
    results = {}
    for name, path in paths.items():
        raw = Path(path).read_bytes()
        samples = json.loads(raw)['samples']['single']
        results[name] = {'source': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                         'historical_blocks': len(samples['r3']), 'historical_size': len(samples['r3'][0]),
                         'designs': [single_probability(samples, size, blocks, replicates=replicates, model=model)
                                     for blocks, size in designs for model in ('pooled', 'paired-block-mixture')]}
    return {'decision': 'D956', 'self_check': self_check(), 'sources': results,
            'limitations': ['R7 lacks scheduled 200ms idle gaps; R9 has six 40-request blocks only.',
                'Resampling cannot invent between-run drift, rare unobserved tails or causal product effects.',
                'The full-rule all-estimands-equal probability remains limited by the two median point<=1 rules; it is not single power.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--r7', required=True)
    parser.add_argument('--r9', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    result = design({'r7': args.r7, 'r9': args.r9}, [(30, 40), (30, 120), (30, 160), (30, 200), (10, 120), (8, 160), (6, 200)])
    Path(args.out).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
