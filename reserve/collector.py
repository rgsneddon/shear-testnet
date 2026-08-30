#!/usr/bin/env python3
"""Write latest.json / history.jsonl for shear-reserve-oracle-v1."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from reserve.normalise import (
    BANK_IDS,
    SCALE_NAME,
    VERSION,
    ForbiddenSeriesError,
    mean_14,
    normalise_bank,
    refuse_overnight,
    tenths_bp_to_percent,
)

ROOT = Path(__file__).resolve().parent
FORBIDDEN_KEYS = ('sofr', 'sonia', 'estr', 'tona', 'corra', 'saron', 'aonia', 'effective')


def load_json(path: Path):
    return json.loads(path.read_text(encoding='utf8'))


def load_sources(path: Path | None = None) -> dict:
    return load_json(path or ROOT / 'sources.json')


def _scan_forbidden(obj) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            refuse_overnight(str(k))
            lk = str(k).lower()
            if any(bad in lk for bad in FORBIDDEN_KEYS):
                raise ForbiddenSeriesError(f'market overnight key refused: {k}')
            _scan_forbidden(v)
    elif isinstance(obj, list):
        for x in obj:
            _scan_forbidden(x)
    elif isinstance(obj, str):
        refuse_overnight(obj)


def components_from_input(payload: dict, sources: dict) -> list[dict]:
    _scan_forbidden(payload)
    by_src = {b['id']: b for b in sources['banks']}
    raw_list = payload.get('components') or payload.get('banks')
    if not raw_list:
        raise ValueError('input needs components[]')
    got = {}
    for row in raw_list:
        bank_id = str(row['id'])
        refuse_overnight(bank_id)
        src = by_src[bank_id]
        entry = {**src, **row, 'id': bank_id}
        got[bank_id] = normalise_bank(entry)
    missing = [i for i in BANK_IDS if i not in got]
    if missing:
        raise ValueError(f'missing banks: {missing}')
    extra = [i for i in got if i not in BANK_IDS]
    if extra:
        raise ValueError(f'unknown banks: {extra}')
    return [got[i] for i in BANK_IDS]


def snapshot_from_components(components: list[dict], *, as_of: str, observed_at: str) -> dict:
    avg_int = mean_14(c['normalisedInteger'] for c in components)
    return {
        'version': VERSION,
        'asOf': as_of,
        'observedAt': observed_at,
        'averagePercent': float(tenths_bp_to_percent(avg_int)),
        'averageScale': SCALE_NAME,
        'averageInteger': avg_int,
        'changed': False,
        'changedBanks': [],
        'components': [
            {
                'id': c['id'],
                'raw': c['raw'],
                'normalisedPercent': c['normalisedPercent'],
                'normalisedInteger': c['normalisedInteger'],
            }
            for c in components
        ],
    }


def apply_update(previous: dict | None, incoming: dict, *, observed_at: str, decision_date: str) -> dict:
    components = incoming['components']
    snap = snapshot_from_components(components, as_of=decision_date, observed_at=observed_at)
    if previous is None:
        snap['changed'] = True
        snap['changedBanks'] = [c['id'] for c in components]
        snap['asOf'] = decision_date
        return snap
    prev_map = {c['id']: c['normalisedInteger'] for c in previous.get('components') or []}
    changed = []
    for c in components:
        if prev_map.get(c['id']) != c['normalisedInteger']:
            changed.append(c['id'])
    if not changed:
        snap['changed'] = False
        snap['changedBanks'] = []
        snap['asOf'] = previous.get('asOf') or decision_date
        snap['averagePercent'] = previous['averagePercent']
        snap['averageInteger'] = previous['averageInteger']
        snap['components'] = previous['components']
        snap['observedAt'] = observed_at
        return snap
    snap['changed'] = True
    snap['changedBanks'] = changed
    snap['asOf'] = decision_date
    return snap


def write_latest(out_dir: Path, snap: dict, *, previous: dict | None) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    latest_path = out_dir / 'latest.json'
    latest_path.write_text(json.dumps(snap, indent=2) + '\n', encoding='utf8')
    if snap.get('changed'):
        with (out_dir / 'history.jsonl').open('a', encoding='utf8') as f:
            f.write(json.dumps(snap, separators=(',', ':')) + '\n')
    return latest_path


def collect(input_path: Path, out_dir: Path, *, observed_at: str | None = None, decision_date: str | None = None) -> dict:
    sources = load_sources()
    payload = load_json(input_path)
    _scan_forbidden(payload)
    components = components_from_input(payload, sources)
    now = observed_at or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    as_of = decision_date or payload.get('asOf') or now[:10]
    prev_path = out_dir / 'latest.json'
    previous = load_json(prev_path) if prev_path.exists() else None
    incoming = {'components': components}
    snap = apply_update(previous, incoming, observed_at=now, decision_date=as_of)
    write_latest(out_dir, snap, previous=previous)
    return snap


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description='shear-reserve-oracle-v1 collector')
    p.add_argument('--input', required=True, help='fixture JSON of official components')
    p.add_argument('--out', default=str(ROOT), help='directory for latest.json and history.jsonl')
    p.add_argument('--observed-at', default=None)
    p.add_argument('--as-of', default=None)
    args = p.parse_args(argv)
    snap = collect(Path(args.input), Path(args.out), observed_at=args.observed_at, decision_date=args.as_of)
    print(json.dumps({'changed': snap['changed'], 'averagePercent': snap['averagePercent'], 'asOf': snap['asOf']}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
