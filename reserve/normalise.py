"""Normalise official policy rates for shear-reserve-oracle-v1.

Canonical integer scale: tenths of a basis point (3.625% = 3625).
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

VERSION = 'shear-reserve-oracle-v1'
SCALE_NAME = 'tenths_of_basis_point'
PERCENT_TO_TENTHS_BP = Decimal(1000)
BANK_COUNT = 14
BANK_IDS = (
    'FED', 'BOE', 'ECB', 'BOJ', 'BOC', 'RBA', 'RBNZ',
    'SNB', 'RIKSBANK', 'NORGES', 'DNBANK', 'BOK', 'BOI', 'CNB',
)
FORBIDDEN_SERIES = frozenset({
    'SOFR', 'SONIA', 'ESTR', '€STR', 'TONA', 'CORRA', 'SARON', 'AONIA',
    'EFFR', 'DFF', 'FEDERAL_FUNDS_EFFECTIVE', 'EFFECTIVE_FUNDS',
    'EFFECTIVE_FEDERAL_FUNDS', 'MARKET_OVERNIGHT',
})


class ForbiddenSeriesError(ValueError):
    pass


def _dec(value) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def round_half_up_int(value: Decimal) -> int:
    return int(value.quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def percent_to_tenths_bp(percent) -> int:
    return round_half_up_int(_dec(percent) * PERCENT_TO_TENTHS_BP)


def tenths_bp_to_percent(tenths_bp: int) -> Decimal:
    return (Decimal(int(tenths_bp)) / PERCENT_TO_TENTHS_BP).quantize(
        Decimal('0.001'), rounding=ROUND_HALF_UP,
    )


def median_range(lower, upper) -> Decimal:
    return (_dec(lower) + _dec(upper)) / Decimal(2)


def parse_raw(raw: str) -> tuple:
    s = str(raw).strip().replace('%', '').replace('–', '-').replace('—', '-')
    if '-' in s:
        lo, hi = s.split('-', 1)
        return ('range', _dec(lo.strip()), _dec(hi.strip()))
    return ('single', _dec(s), None)


def refuse_overnight(series_id: str) -> None:
    key = str(series_id or '').strip().upper().replace('€', 'E')
    if key in FORBIDDEN_SERIES or key.replace('_', '') in {x.replace('_', '') for x in FORBIDDEN_SERIES}:
        raise ForbiddenSeriesError(f'market overnight series refused: {series_id}')


def normalise_bank(entry: dict) -> dict:
    bank_id = str(entry.get('id') or '')
    refuse_overnight(bank_id)
    for extra in entry.get('series') or []:
        refuse_overnight(str(extra))
    kind = str(entry.get('kind') or 'single')
    if kind == 'corridor':
        if entry.get('marginal_lending_facility') is not None and entry.get('deposit') is None:
            raise ForbiddenSeriesError('ECB v1 corridor is deposit+MRO, not marginal lending')
        if 'deposit' in entry and 'mro' in entry:
            mid = median_range(entry['deposit'], entry['mro'])
            raw = f"{_dec(entry['deposit'])}-{_dec(entry['mro'])}"
        else:
            parsed = parse_raw(entry['raw'])
            if parsed[0] != 'range':
                raise ValueError(f'ECB corridor needs a range, got {entry.get("raw")!r}')
            mid = median_range(parsed[1], parsed[2])
            raw = str(entry['raw'])
        n = percent_to_tenths_bp(mid)
        return {
            'id': bank_id,
            'raw': raw,
            'normalisedPercent': float(tenths_bp_to_percent(n)),
            'normalisedInteger': n,
        }
    if kind == 'range':
        parsed = parse_raw(entry['raw'])
        if parsed[0] != 'range':
            raise ValueError(f'{bank_id} range needs lower-upper, got {entry.get("raw")!r}')
        mid = median_range(parsed[1], parsed[2])
        n = percent_to_tenths_bp(mid)
        return {
            'id': bank_id,
            'raw': str(entry['raw']),
            'normalisedPercent': float(tenths_bp_to_percent(n)),
            'normalisedInteger': n,
        }
    parsed = parse_raw(entry['raw'])
    if parsed[0] != 'single':
        raise ValueError(f'{bank_id} single rate must not be a range')
    n = percent_to_tenths_bp(parsed[1])
    return {
        'id': bank_id,
        'raw': str(entry['raw']),
        'normalisedPercent': float(tenths_bp_to_percent(n)),
        'normalisedInteger': n,
    }


def mean_14(tenths_bp_values) -> int:
    vals = [int(x) for x in tenths_bp_values]
    if len(vals) != BANK_COUNT:
        raise ValueError(f'need {BANK_COUNT} rates, got {len(vals)}')
    return round_half_up_int(Decimal(sum(vals)) / Decimal(BANK_COUNT))
