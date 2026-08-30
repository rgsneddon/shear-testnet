import json
import unittest
from pathlib import Path

from reserve.normalise import (
    BANK_IDS,
    ForbiddenSeriesError,
    mean_14,
    median_range,
    normalise_bank,
    percent_to_tenths_bp,
    refuse_overnight,
    tenths_bp_to_percent,
)

ROOT = Path(__file__).resolve().parents[1]


class NormaliseTests(unittest.TestCase):
    def test_fed_range_median(self):
        got = normalise_bank({'id': 'FED', 'kind': 'range', 'raw': '3.50-3.75'})
        self.assertEqual(got['normalisedPercent'], 3.625)
        self.assertEqual(got['normalisedInteger'], 3625)
        self.assertEqual(percent_to_tenths_bp(3.625), 3625)

    def test_single_rate_passthrough(self):
        got = normalise_bank({'id': 'BOE', 'kind': 'single', 'raw': '3.75'})
        self.assertEqual(got['normalisedPercent'], 3.75)
        self.assertEqual(got['normalisedInteger'], 3750)

    def test_ecb_corridor_is_deposit_and_mro_not_mlf(self):
        mid = median_range('2.00', '2.15')
        got = normalise_bank({
            'id': 'ECB',
            'kind': 'corridor',
            'deposit': '2.00',
            'mro': '2.15',
            'raw': '2.00-2.15',
        })
        self.assertEqual(got['normalisedInteger'], percent_to_tenths_bp(mid))
        self.assertEqual(got['normalisedPercent'], 2.075)
        with_mlf = normalise_bank({
            'id': 'ECB',
            'kind': 'corridor',
            'deposit': '2.00',
            'mro': '2.15',
            'marginal_lending_facility': '2.40',
            'raw': '2.00-2.15',
        })
        self.assertEqual(with_mlf['normalisedPercent'], got['normalisedPercent'])
        with self.assertRaises(ForbiddenSeriesError):
            normalise_bank({
                'id': 'ECB',
                'kind': 'corridor',
                'marginal_lending_facility': '2.40',
            })

    def test_unweighted_mean_of_14(self):
        fixture = json.loads((ROOT / 'fixtures' / 'snapshot_a.json').read_text())
        ints = [normalise_bank(c)['normalisedInteger'] for c in fixture['components']]
        self.assertEqual(len(ints), 14)
        self.assertEqual([c['id'] for c in fixture['components']], list(BANK_IDS))
        avg = mean_14(ints)
        self.assertEqual(avg, 2636)
        self.assertEqual(float(tenths_bp_to_percent(avg)), 2.636)

    def test_refuse_overnight_ids(self):
        for sid in ('SOFR', 'SONIA', '€STR', 'EFFR', 'AONIA'):
            with self.assertRaises(ForbiddenSeriesError):
                refuse_overnight(sid)


if __name__ == '__main__':
    unittest.main()
