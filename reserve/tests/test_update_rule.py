import json
import tempfile
import unittest
from pathlib import Path

from reserve.collector import collect, components_from_input, load_sources
from reserve.normalise import ForbiddenSeriesError


ROOT = Path(__file__).resolve().parents[1]


class UpdateRuleTests(unittest.TestCase):
    def setUp(self):
        self.sources = load_sources(ROOT / 'sources.json')
        self.snap_a = json.loads((ROOT / 'fixtures' / 'snapshot_a.json').read_text())
        self.snap_b = json.loads((ROOT / 'fixtures' / 'snapshot_b.json').read_text())

    def test_identical_refetch_does_not_mutate_average(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            first = collect(
                ROOT / 'fixtures' / 'snapshot_a.json',
                out,
                observed_at='2026-08-01T12:00:00Z',
                decision_date='2026-08-01',
            )
            self.assertTrue(first['changed'])
            self.assertEqual(first['version'], 'shear-reserve-oracle-v1')
            self.assertEqual(len(first['components']), 14)
            avg = first['averagePercent']
            vec = first['components']
            as_of = first['asOf']
            hist1 = (out / 'history.jsonl').read_text().strip().splitlines()
            self.assertEqual(len(hist1), 1)

            second = collect(
                ROOT / 'fixtures' / 'snapshot_a.json',
                out,
                observed_at='2026-08-02T12:00:00Z',
                decision_date='2026-08-02',
            )
            self.assertFalse(second['changed'])
            self.assertEqual(second['changedBanks'], [])
            self.assertEqual(second['averagePercent'], avg)
            self.assertEqual(second['averageInteger'], first['averageInteger'])
            self.assertEqual(second['components'], vec)
            self.assertEqual(second['asOf'], as_of)
            self.assertEqual(second['observedAt'], '2026-08-02T12:00:00Z')
            hist2 = (out / 'history.jsonl').read_text().strip().splitlines()
            self.assertEqual(len(hist2), 1)

            third = collect(
                ROOT / 'fixtures' / 'snapshot_b.json',
                out,
                observed_at='2026-08-15T12:00:00Z',
                decision_date='2026-08-15',
            )
            self.assertTrue(third['changed'])
            self.assertEqual(third['changedBanks'], ['BOE'])
            self.assertEqual(third['asOf'], '2026-08-15')
            self.assertNotEqual(third['averagePercent'], avg)
            hist3 = (out / 'history.jsonl').read_text().strip().splitlines()
            self.assertEqual(len(hist3), 2)
            latest = json.loads((out / 'latest.json').read_text())
            self.assertEqual(latest['version'], 'shear-reserve-oracle-v1')
            self.assertEqual(latest['averageScale'], 'tenths_of_basis_point')
            self.assertEqual(len(latest['components']), 14)

    def test_overnight_fixture_refused(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ForbiddenSeriesError):
                collect(ROOT / 'fixtures' / 'overnight_forbidden.json', Path(td))

    def test_components_from_input_uses_sources(self):
        comps = components_from_input(self.snap_a, self.sources)
        self.assertEqual([c['id'] for c in comps], [
            'FED', 'BOE', 'ECB', 'BOJ', 'BOC', 'RBA', 'RBNZ',
            'SNB', 'RIKSBANK', 'NORGES', 'DNBANK', 'BOK', 'BOI', 'CNB',
        ])
        fed = comps[0]
        self.assertEqual(fed['normalisedPercent'], 3.625)


if __name__ == '__main__':
    unittest.main()
