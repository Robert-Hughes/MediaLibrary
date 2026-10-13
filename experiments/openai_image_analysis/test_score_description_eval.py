import unittest
from score_description_eval import evaluate


class ReviewScoringTests(unittest.TestCase):
    def setUp(self):
        self.corpus = {'cases': [{'id': 'animal', 'group': 'regression', 'provisional': False}]}
        self.records = [{'case_id': 'animal', 'group': 'regression', 'prompt': p,
                         'repetition': 1, 'model': 'gpt-6-luna', 'usage': {}}
                        for p in ('v1', 'v2')]
        self.reviews = {'reviewer': 'test reviewer', 'reviews': [
            {**{k: r[k] for k in ('case_id', 'prompt', 'repetition')},
             'identity': 'supported_generic', 'rationale': 'Visible mammal retained without unsupported species.',
             'indexed_false_claims': [], 'unsupported_details': [], 'salient_subject_present': True}
            for r in self.records]}

    def test_requires_review_of_every_output(self):
        self.reviews['reviews'].pop()
        with self.assertRaisesRegex(ValueError, 'complete review'):
            evaluate(self.records, self.corpus, self.reviews, 1)

    def test_provisional_identity_cannot_inflate_correctness(self):
        self.corpus['cases'][0]['provisional'] = True
        self.reviews['reviews'][0]['identity'] = 'correct_specific'
        with self.assertRaisesRegex(ValueError, 'Provisional'):
            evaluate(self.records, self.corpus, self.reviews, 1)

    def test_contradictory_tags_cannot_pass_with_generic_prose(self):
        self.reviews['reviews'][0]['indexed_false_claims'] = ['rabbit']
        with self.assertRaisesRegex(ValueError, 'False indexed'):
            evaluate(self.records, self.corpus, self.reviews, 1)

    def test_omitted_subject_is_counted_separately(self):
        self.reviews['reviews'][0]['identity'] = 'unresolved'
        self.reviews['reviews'][0]['salient_subject_present'] = False
        summary, _ = evaluate(self.records, self.corpus, self.reviews, 1)
        self.assertEqual(summary['scores']['v1']['unresolved'], 1)
        self.assertEqual(summary['scores']['v1']['salient_subject_present'], 0)

    def test_context_pair_is_scored_without_old_v1_records(self):
        for row in self.records + self.reviews['reviews']:
            row['prompt'] = 'v2_context' if row['prompt'] == 'v2' else 'v2'
        summary, _ = evaluate(self.records, self.corpus, self.reviews, 1, ('v2', 'v2_context'))
        self.assertEqual(set(summary['usage']), {'v2', 'v2_context'})
        self.assertEqual(summary['scores']['v2_context']['supported_generic'], 1)

    def test_arbitrary_variants_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            evaluate(self.records, self.corpus, self.reviews, 1, ('v2', 'unknown'))

    def test_duplicate_results_are_rejected(self):
        self.records.append(self.records[0])
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            evaluate(self.records, self.corpus, self.reviews, 1)


if __name__ == '__main__':
    unittest.main()
