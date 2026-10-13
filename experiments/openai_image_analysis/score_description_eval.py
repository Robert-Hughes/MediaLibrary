"""Offline final scoring with a complete, explicit visual-review annotation set.

No network, credentials or AI judge. Raw screening scores remain untouched.
Every annotation is keyed to one case/prompt/repetition and includes a rationale.
"""
import argparse
import collections
import json
from pathlib import Path

OUTCOMES = {
    'correct_specific', 'supported_generic', 'incorrect', 'unresolved',
    'provisional_specific', 'api_output_error',
}


def load_records(path):
    return [json.loads(line) for line in path.read_text(encoding='utf8').splitlines() if line.strip()]


def key(row):
    return (row['case_id'], row['prompt'], row['repetition'])


def evaluate(records, corpus, annotations, repetitions, variants=('v1', 'v2')):
    if tuple(variants) not in (('v1', 'v2'), ('v2', 'v2_context')):
        raise ValueError('Unsupported paired experiment variants')
    cases = {case['id']: dict(case) for case in corpus['cases']}
    # Preserve the original run manifest while making evidence-backed reference
    # corrections explicit. These affect both prompts identically, without calls.
    for correction in annotations.get('reference_corrections', []):
        if correction['case_id'] not in cases or not correction.get('basis'):
            raise ValueError('Reference corrections need a known case and evidence')
        cases[correction['case_id']]['truth'] = correction['truth']
    expected = {(case_id, prompt, rep) for case_id in cases
                for prompt in variants for rep in range(1, repetitions + 1)}
    record_keys = [key(row) for row in records]
    if len(record_keys) != len(set(record_keys)) or set(record_keys) != expected:
        raise ValueError('Raw records must contain exactly one result for every planned case/prompt/repetition')
    if any(row['model'] != 'gpt-6-luna' for row in records):
        raise ValueError('Only gpt-6-luna records are accepted')
    annotation_keys = [key(row) for row in annotations['reviews']]
    if len(annotation_keys) != len(set(annotation_keys)) or set(annotation_keys) != expected:
        raise ValueError('A complete review of every output is required; duplicate or missing annotations')
    if not annotations.get('reviewer'):
        raise ValueError('Reviewer attribution is required')
    reviewed = {key(row): row for row in annotations['reviews']}
    summaries = {}
    final_rows = []
    identity_by_case = collections.defaultdict(list)
    for record in records:
        annotation = reviewed[key(record)]
        case = cases[record['case_id']]
        outcome = annotation['identity']
        if outcome not in OUTCOMES or not annotation.get('rationale'):
            raise ValueError('Every output needs a valid outcome and a rationale')
        if case.get('provisional') and outcome == 'correct_specific':
            raise ValueError('Provisional species cannot count as confirmed specific recognition')
        if record.get('error') and outcome != 'api_output_error':
            raise ValueError('Output errors cannot receive a quality pass')
        indexed_false_claims = annotation['indexed_false_claims']
        unsupported_details = annotation['unsupported_details']
        if indexed_false_claims and outcome != 'incorrect':
            raise ValueError('False indexed identities cannot be hidden by cautious prose')
        if not isinstance(annotation['salient_subject_present'], bool):
            raise ValueError('Explicit salient-subject coverage is required')
        for bucket in (record['prompt'], record['prompt'] + '/' + case['group']):
            stats = summaries.setdefault(bucket, collections.Counter())
            stats['outputs'] += 1
            stats[outcome] += 1
            stats['false_indexed_outputs'] += bool(indexed_false_claims)
            stats['unsupported_detail_outputs'] += bool(unsupported_details)
            stats['salient_subject_present'] += annotation['salient_subject_present']
        identity_by_case[(record['case_id'], record['prompt'])].append(outcome)
        final_rows.append({
            **{k: record[k] for k in ('case_id', 'group', 'prompt', 'repetition', 'model')},
            'automatic_score': record.get('score'), 'review': annotation,
        })
    instability = {prompt: [case_id for (case_id, p), values in identity_by_case.items()
                           if p == prompt and len(set(values)) > 1] for prompt in variants}
    usage = {prompt: collections.Counter() for prompt in variants}
    for row in records:
        usage[row['prompt']].update({k: v for k, v in row['usage'].items() if isinstance(v, int)})
    return {
        'model': 'gpt-6-luna', 'generation_requests': len(records), 'judge_api_calls': 0,
        'reviewer': annotations['reviewer'], 'repetitions': repetitions,
        'scores': {k: dict(v) for k, v in summaries.items()},
        'identity_outcome_instability': instability,
        'usage': {k: dict(v) for k, v in usage.items()},
        'reference_corrections': annotations.get('reference_corrections', []),
        'notes': 'Targeted paired corpus; outcomes are not a whole-library error-rate estimate. Provisional identities are separate. Unsupported details and generic specificity are separate from wrong identity.',
    }, final_rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_directory', type=Path)
    parser.add_argument('annotations', type=Path)
    args = parser.parse_args()
    root = args.run_directory
    records = load_records(root / 'responses.jsonl')
    corpus = json.loads((root / 'corpus.json').read_text(encoding='utf8'))
    settings = json.loads((root / 'request-settings.json').read_text(encoding='utf8'))
    annotations = json.loads(args.annotations.read_text(encoding='utf8'))
    summary, final_rows = evaluate(records, corpus, annotations, settings['repetitions'], settings.get('variants', ('v1', 'v2')))
    automatic = json.loads((root / 'automatic-summary.json').read_text(encoding='utf8'))
    summary['cost_usd'] = automatic['cost_usd']
    (root / 'reviewed-summary.json').write_text(json.dumps(summary, indent=2), encoding='utf8')
    (root / 'reviewed-results.json').write_text(json.dumps(final_rows, indent=2), encoding='utf8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
