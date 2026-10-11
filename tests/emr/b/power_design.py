"""REQ-D961 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT -> whole-plan power.

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

from noninferiority import (T95, log_ratio_bound, p95, SINGLE_BLOCKS,
                           SINGLE_REQUESTS, CONCURRENT_BLOCKS, SUSTAINED_BLOCKS)


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


def workload_probability(samples, size, blocks, *, concurrent=False,
                         replicates=20000, seed=956, model='paired-block-mixture'):
    """Resample requests within paired historical regimes, then whole blocks.

    At equality both arms use the same merged within-regime population. At
    observed effects each uses its recorded arm. Concurrent median and p95
    are computed from the SAME resampled requests to retain their dependence.
    Sustained/single p95 uses the exact empirical order-statistic shortcut.
    """
    if not concurrent:
        return single_probability(samples, size, blocks, replicates=replicates, seed=seed, model=model)
    if model not in ('pooled', 'paired-block-mixture') or not 2 <= blocks <= 31 or size < 2:
        raise ValueError('unsupported prospective design')
    if len(samples['r3']) != len(samples['candidate']):
        raise ValueError('paired historical blocks required')
    pairs = list(zip(samples['r3'], samples['candidate']))
    if model == 'pooled':
        pairs = [(sum(samples['r3'], []), sum(samples['candidate'], []))]
    for a, b in pairs:
        p95(a)
        p95(b)
    if not pairs:
        raise ValueError('historical blocks required')
    rng = random.Random(seed)
    banks = {'at_equality': [], 'at_observed': []}
    for _ in range(20000):
        a, b = rng.choice(pairs)
        pool = a + b
        for scenario, populations in [('at_equality', (pool, pool)), ('at_observed', (a, b))]:
            before, after = [sorted(rng.choices(p, k=size)) for p in populations]
            rank = math.ceil(.95 * size) - 1
            banks[scenario].append((math.log(after[rank] / before[rank]),
                                   math.log(statistics.median(after) / statistics.median(before))))
    answer = {}
    for scenario, bank in banks.items():
        tail_count = median_count = joint_count = 0
        for _ in range(replicates):
            pairs_drawn = rng.choices(bank, k=blocks)
            tail, median = zip(*pairs_drawn)
            def accepted(logs, point_required):
                mean = sum(logs) / blocks
                sd = math.sqrt(sum((x - mean) ** 2 for x in logs) / (blocks - 1))
                return ((not point_required or mean <= math.log(1.10))
                        and mean + T95[blocks-1] * sd / math.sqrt(blocks) <= math.log(1.10))
            tail_ok, median_ok = accepted(tail, True), accepted(median, False)
            tail_count += tail_ok
            median_count += median_ok
            joint_count += tail_ok and median_ok
        p = joint_count / replicates
        answer.update({scenario: p, scenario + '_tail': tail_count / replicates,
                       scenario + '_median': median_count / replicates,
                       scenario + '_monte_carlo_se': math.sqrt(p * (1-p) / replicates),
                       scenario + '_tail_median_correlation': statistics.correlation(*zip(*bank))
                       if all(statistics.stdev(v) > 0 for v in zip(*bank)) else None})
    return {**answer, 'model': model, 'blocks': blocks, 'requests_per_block': size,
            'seed': seed, 'replicates': replicates, 'bank_size': 20000,
            'scope': 'concurrent p95 point/UB<=1.10 AND median UB<=1.10; shared request draws'}


def joint_probability(workloads):
    """Independent workloads; concurrent tail/median already joint above."""
    result = {}
    for scenario in ('at_equality', 'at_observed'):
        values = [w[scenario] for w in workloads.values()]
        result['whole_plan_' + scenario] = math.prod(values)
        # Delta-method MC error for independent simulation streams; this is
        # not an interval for the unknown population or fitted model error.
        result['whole_plan_' + scenario + '_monte_carlo_se'] = math.sqrt(sum(
            math.prod(values[:i] + values[i+1:]) ** 2 * w[scenario + '_monte_carlo_se'] ** 2
            for i, w in enumerate(workloads.values())))
    return result


def design(paths, selected=None, replicates=20000):
    selected = selected or {'single_blocks': SINGLE_BLOCKS, 'requests_per_block': SINGLE_REQUESTS,
                            'concurrent_bursts': CONCURRENT_BLOCKS, 'sustained_blocks': SUSTAINED_BLOCKS,
                            'sustained_requests': 200}
    results = {}
    for name, workload_paths in paths.items():
        sources, samples = {}, {}
        for work, path in workload_paths.items():
            raw = Path(path).read_bytes()
            samples[work] = json.loads(raw)['samples'][work]
            sources[work] = {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                             'historical_blocks': len(samples[work]['r3']),
                             'historical_size': len(samples[work]['r3'][0])}
        models = {}
        for model in ('pooled', 'paired-block-mixture'):
            workloads = {}
            for i, (work, sample) in enumerate(samples.items()):
                concurrent = work.startswith('concurrent')
                size = int(work.split('-')[-1]) if concurrent else selected['requests_per_block'] if work == 'single' else selected['sustained_requests']
                blocks = selected['concurrent_bursts'] if concurrent else selected['single_blocks'] if work == 'single' else selected['sustained_blocks']
                workloads[work] = workload_probability(sample, size, blocks, concurrent=concurrent,
                                                       replicates=replicates, seed=956+i, model=model)
            models[model] = {'workloads': workloads, **joint_probability(workloads)}
        results[name] = {'sources': sources, 'models': models}
    # Paired blocks are the experimental units. The block-mixture model retains
    # their local populations; global pooling instead invents iid mixing of
    # different historical host regimes within a new block. Keep that stress
    # model visible, but do not silently call it the registered block model.
    # Select the least-powered historical source separately for each workload.
    conservative, selections = {}, {}
    for work in ('single', 'sustained', 'concurrent-24', 'concurrent-48'):
        _, source, model, value = min((m['workloads'][work]['at_equality'], source, model, m['workloads'][work])
            for source, s in results.items() for model, m in s['models'].items()
            if model == 'paired-block-mixture')
        conservative[work] = value
        selections[work] = {'source': source, 'model': model}
    joint = joint_probability(conservative)
    pooled = {work: min((s['models']['pooled']['workloads'][work] for s in results.values()),
                       key=lambda w: w['at_equality']) for work in conservative}
    return {'decision': 'D961', 'self_check': self_check(), 'design': selected, 'sources': results,
            'conservative_selections': selections, 'conservative_workloads': conservative, **joint,
            'global_pooling_sensitivity': joint_probability(pooled),
            'whole_plan_equality_target': .80,
            'whole_plan_equality_target_met': joint['whole_plan_at_equality'] >= .80,
            'scope': 'all four workloads jointly; single/sustained p95 and concurrent-24/48 p95+median',
            'assumptions': ['Independent workloads; correlated tail and median from the same concurrent request draws.',
                'Equality pools both arms within each historical paired block; observed effects retain separate arms.',
                'Primary paired-block-mixture envelope uses the lowest equality-power historical source per workload across r7/r9/r10; observed probability uses these same sources.',
                'Global pooling is a separate sensitivity model that mixes historical regimes within every block; its result is not hidden or claimed to meet the target.',
                'Conditional on functional/JIT/attribution/quiet-host validity and killed M36, not a probability of those controls succeeding.'],
            'limitations': ['R7 lacks scheduled 200ms idle gaps; R9 has six 40-request single/sustained blocks; R10 has ten 120-request single and six 40-request sustained blocks.',
                'Resampling assumes iid requests within a historical regime and independent resampled blocks; it cannot invent future drift or unobserved tails.',
                'Monte Carlo error excludes fitted-model uncertainty; prospective design evidence is not acceptance evidence.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', required=True, help='JSON mapping round -> workload -> exact summary path')
    parser.add_argument('--design', help='optional JSON with selected block/request counts')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    result = design(json.loads(Path(args.sources).read_bytes()),
                    json.loads(Path(args.design).read_bytes()) if args.design else None)
    Path(args.out).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(result, indent=2))
