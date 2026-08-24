"""
Digital Leaders World Map -- data pipeline.

Reads the Excel master file and emits viz/data/dl-data.json, the single file
the visualisation loads. The Excel is the source of truth: nothing is ever
edited in the JSON by hand, and every aggregate here is recomputed from the
institution rows rather than carried over.

Usage:
    python build_data.py                 # build, writing data/dl-data.json
    python build_data.py --check         # build and diff against the existing
                                         # file without writing (exit 1 if changed)

DL Points: an institution ranked r in a module earns (151 - r) points, so 1st
is worth 150 and 150th is worth 1. Country, region and hub totals are the sum
over their institutions.
"""

import argparse
import json
import math
import os
import re
import sys
from datetime import datetime

import pandas as pd

SCHEMA_VERSION = '1.0'

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE_XLSX = os.path.join(HERE, '..', 'DL_world_map_master_file_all_hubs.xlsx')
OUTPUT_JSON = os.path.join(HERE, 'data', 'dl-data.json')

EDITIONS = ['DL25', 'DL26']
MODULES = ['global', 'AI', 'CS', 'transform', 'create']

RANKING_DEPTH = 150            # how many places are SCORED in each module
MAX_RANK_POINTS = RANKING_DEPTH + 1   # points = MAX_RANK_POINTS - rank

# The Next 50 (Global ranks 151-200) is a named tier, not extra ranking depth.
# Its institutions are listed, filterable and mapped, but score zero.
#
# Widening DL Points to a 200-place scale was considered and rejected: it adds
# 50 points to every ranked institution, and since DL25 has no Next 50 the
# whole gain lands in the Evolution measure as growth that never happened
# (~7,500 points across the map; India's real -421 would read as +29).
#
# Anything beyond NEXT50_DEPTH is an error, not a tier -- UT Austin's
# `rank CS DL25 = 239` is the standing example.
NEXT50_DEPTH = 200
NEXT50_MODULES = ['global']    # the Next 50 exists for the global ranking only


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def clean(value):
    """Excel blanks arrive as NaN; JSON wants null."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return value


def as_number(value):
    value = clean(value)
    if value is None:
        return None
    return float(value)


def as_rank(value, module=None):
    """
    A rank as published. Scored ranks are 1-150; the Global ranking also
    carries a Next 50 tier at 151-200. Anything else is bad data.
    """
    value = clean(value)
    if value is None:
        return None
    rank = int(round(float(value)))
    if rank < 1:
        return None
    ceiling = NEXT50_DEPTH if module in NEXT50_MODULES else RANKING_DEPTH
    return None if rank > ceiling else rank


def is_scored(rank):
    return rank is not None and rank <= RANKING_DEPTH


def tier_of(rank):
    """'top150', 'next50', or None when the institution is not ranked here."""
    if rank is None:
        return None
    return 'top150' if rank <= RANKING_DEPTH else 'next50'


def slugify(name):
    slug = re.sub(r'[^a-z0-9]+', '-', str(name).lower()).strip('-')
    return slug or 'institution'


def points_for(rank):
    """Only the scored top 150 carries points; the Next 50 is worth zero."""
    if rank is None:
        return None
    return float(MAX_RANK_POINTS - rank) if is_scored(rank) else 0.0


def empty_totals():
    return {edition: {module: 0.0 for module in MODULES} for edition in EDITIONS}


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def load_hub_coordinates(path):
    """
    Explicit hub centres from the workbook's "Hubs" sheet.

    Hubs used to be placed at the mean position of their members, which put
    several of them in the sea: one member with a bad coordinate drags the
    average across an ocean, and even with clean members the centroid of
    "Paris" is not Paris. Returns {} if the sheet is absent, in which case
    build() falls back to the old averaging.
    """
    try:
        sheet = pd.read_excel(path, sheet_name='Hubs')
    except ValueError:
        return {}

    return {
        str(row['Hub Name']): (float(row['Latitude']), float(row['Longitude']))
        for _, row in sheet.iterrows()
        if pd.notna(row.get('Hub Name'))
    }


def next50_only(row):
    """True when a row appears in the ranking ONLY through the Next 50."""
    tiers = [tier_of(as_rank(row.get('rank %s %s' % (module, edition)), module))
             for edition in EDITIONS for module in MODULES]
    return 'next50' in tiers and 'top150' not in tiers


def build(df, hub_coordinates=None):
    hub_coordinates = hub_coordinates or {}
    institutions = []
    seen_ids = {}

    # Country and hub member counts must read exactly as they did before the
    # Next 50 existed, so the rows the tier brought in are left out of them.
    # The institution list itself keeps every row -- the map's dot layer needs
    # them.
    counted = df[~df.apply(next50_only, axis=1)]

    for _, row in df.iterrows():
        name = str(row['institution']).strip()

        # Slugs are the stable id used by the front end; collisions would make
        # two institutions indistinguishable, so they are made unique.
        base = slugify(name)
        seen_ids[base] = seen_ids.get(base, 0) + 1
        institution_id = base if seen_ids[base] == 1 else '%s-%d' % (base, seen_ids[base])

        ranks = {
            edition: {
                module: as_rank(row.get('rank %s %s' % (module, edition)), module)
                for module in MODULES
            }
            for edition in EDITIONS
        }

        institutions.append({
            'id': institution_id,
            'name': name,
            'type': clean(row['type']),
            'country': clean(row['country']),
            'region': clean(row['region']),
            'hub': clean(row.get('Hub Name')),
            'hubSubtitle': clean(row.get('Hub Subheading')),
            'latitude': as_number(row.get('Latitude')),
            'longitude': as_number(row.get('Longitude')),
            'ranks': ranks,
            # Per-institution points are deliberately NOT published. They are
            # `151 - rank` and the front end computes them on the fly, so
            # shipping them would only hand out the module-by-module breakdown
            # that the interface is careful not to expose. The ranks are public
            # by design; the arithmetic on top of them is Emerging's to sell.
            # 'top150' or 'next50' per module, so the front end never has to
            # rediscover the threshold for itself.
            'tier': {
                edition: {module: tier_of(ranks[edition][module]) for module in MODULES}
                for edition in EDITIONS
            },
            # True when the institution appears in the ranking ONLY through the
            # Next 50 — no scored placing in any module, in either edition.
            # These are the rows the Next 50 brought in, and the country and hub
            # views ignore them completely, so adding the tier changed no
            # existing count. Institutions that merely sit in the Next 50 for
            # Global while ranking normally elsewhere are NOT flagged: they were
            # always in the file and must keep appearing exactly as before.
            'next50Only': (
                any(tier_of(ranks[e][m]) == 'next50' for e in EDITIONS for m in MODULES)
                and not any(tier_of(ranks[e][m]) == 'top150' for e in EDITIONS for m in MODULES)
            ),
        })

    # -- country aggregates -------------------------------------------------
    countries = []
    for name, group in counted.groupby('country', sort=True):
        totals = empty_totals()
        for _, row in group.iterrows():
            for edition in EDITIONS:
                for module in MODULES:
                    rank = as_rank(row.get('rank %s %s' % (module, edition)), module)
                    if is_scored(rank):
                        totals[edition][module] += (MAX_RANK_POINTS - rank)

        first = group.iloc[0]
        countries.append({
            'name': name,
            'region': clean(first['region']),
            'incomeGroup': clean(first.get('country inc.group')),
            'gdpPerCapita': as_number(first.get('country gdp.capita')),
            'population': as_number(first.get('country population')),
            'nriScore': as_number(first.get('country NRI score')),
            'coordinates': {
                'latitude': as_number(first.get('Latitude')),
                'longitude': as_number(first.get('Longitude')),
            },
            'metrics': {
                edition: {
                    'institutions': int(len(group)),
                    'dlPoints': {module: totals[edition][module] for module in MODULES},
                }
                for edition in EDITIONS
            },
            'delta': {
                'dlPointsGlobal': totals['DL26']['global'] - totals['DL25']['global']
            },
        })

    # -- region aggregates ---------------------------------------------------
    regions = []
    for name, group in counted.groupby('region', sort=True):
        totals = empty_totals()
        for _, row in group.iterrows():
            for edition in EDITIONS:
                for module in MODULES:
                    rank = as_rank(row.get('rank %s %s' % (module, edition)), module)
                    if is_scored(rank):
                        totals[edition][module] += (MAX_RANK_POINTS - rank)

        regions.append({
            'name': name,
            'institutions': int(len(group)),
            'metrics': {
                edition: {'dlPoints': {module: totals[edition][module] for module in MODULES}}
                for edition in EDITIONS
            },
            'delta': {
                'dlPointsGlobal': totals['DL26']['global'] - totals['DL25']['global']
            },
        })

    # -- hub aggregates ------------------------------------------------------
    hubs = []
    hub_rows = counted[counted['Hub Name'].notna()]
    for name, group in hub_rows.groupby('Hub Name', sort=True):
        totals = empty_totals()
        for _, row in group.iterrows():
            for edition in EDITIONS:
                for module in MODULES:
                    rank = as_rank(row.get('rank %s %s' % (module, edition)), module)
                    if is_scored(rank):
                        totals[edition][module] += (MAX_RANK_POINTS - rank)

        first = group.iloc[0]
        # An explicit centre from the Hubs sheet always wins; averaging is only
        # a fallback for a hub that has not been given one.
        latitude, longitude = hub_coordinates.get(
            name, (float(group['Latitude'].mean()), float(group['Longitude'].mean())))

        hubs.append({
            'name': name,
            'country': clean(first['country']),
            'latitude': latitude,
            'longitude': longitude,
            'institutions': int(len(group)),
            'metrics': {
                edition: {'dlPoints': {module: totals[edition][module] for module in MODULES}}
                for edition in EDITIONS
            },
            'delta': {
                'dlPointsGlobal': totals['DL26']['global'] - totals['DL25']['global']
            },
        })

    return {
        'schema_version': SCHEMA_VERSION,
        'generated': datetime.now().isoformat(),
        'editions': EDITIONS,
        'modules': MODULES,
        'institutions': institutions,
        'countries': countries,
        'regions': regions,
        'hubs': hubs,
    }


# ---------------------------------------------------------------------------
# verification
# ---------------------------------------------------------------------------

def compare(old, new):
    """Report meaningful differences, ignoring the build timestamp."""
    differences = []

    for key in ['schema_version', 'editions', 'modules']:
        if old.get(key) != new.get(key):
            differences.append('%s: %r -> %r' % (key, old.get(key), new.get(key)))

    for collection in ['institutions', 'countries', 'regions', 'hubs']:
        old_items = {i.get('name'): i for i in old.get(collection, [])}
        new_items = {i.get('name'): i for i in new.get(collection, [])}

        for missing in sorted(set(old_items) - set(new_items)):
            differences.append('%s: dropped %s' % (collection, missing))
        for added in sorted(set(new_items) - set(old_items)):
            differences.append('%s: added %s' % (collection, added))

        for name in sorted(set(old_items) & set(new_items)):
            before, after = old_items[name], new_items[name]
            for field in sorted(set(before) | set(after)):
                if before.get(field) != after.get(field):
                    differences.append('%s / %s / %s: %r -> %r' % (
                        collection, name, field, before.get(field), after.get(field)))

    return differences


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true',
                        help='build and diff against the existing file without writing')
    parser.add_argument('--source', default=SOURCE_XLSX)
    parser.add_argument('--output', default=OUTPUT_JSON)
    args = parser.parse_args()

    df = pd.read_excel(args.source)
    print('read %d rows x %d columns from %s' % (df.shape[0], df.shape[1],
                                                 os.path.basename(args.source)))

    # The points formula assumes a 150-deep ranking. If a "Next 50" (ranks
    # 151-200) is ever loaded, rank 151 scores 0 and rank 200 scores -49, so
    # the formula needs a decision before the data lands rather than after.
    out_of_range = []
    next50_count = 0
    for edition in EDITIONS:
        for module in MODULES:
            column = 'rank %s %s' % (module, edition)
            if column not in df.columns:
                continue
            ceiling = NEXT50_DEPTH if module in NEXT50_MODULES else RANKING_DEPTH
            next50_count += int(df[column].between(RANKING_DEPTH + 1, ceiling).sum())
            for _, row in df[(df[column] > ceiling) | (df[column] < 1)].iterrows():
                out_of_range.append((row['institution'], column, row[column]))

    if next50_count:
        print('Next 50 tier: %d institution(s) at ranks %d-%d — listed, not scored'
              % (next50_count, RANKING_DEPTH + 1, NEXT50_DEPTH))

    if out_of_range:
        print('\nWARNING: %d rank(s) outside the published range, counted as unranked:'
              % len(out_of_range))
        for institution, column, value in out_of_range:
            print('   %-22s %-20s %s' % (str(institution)[:22], column, value))

    hub_coordinates = load_hub_coordinates(args.source)
    print('hub centres: %s' % ('%d from the Hubs sheet' % len(hub_coordinates)
                               if hub_coordinates else 'none -- averaging members'))

    payload = build(df, hub_coordinates)
    print('built %d institutions, %d countries, %d regions, %d hubs' % (
        len(payload['institutions']), len(payload['countries']),
        len(payload['regions']), len(payload['hubs'])))

    placed = [h for h in payload['hubs'] if h['name'] not in hub_coordinates]
    if placed:
        print('WARNING: no explicit centre for %s' % ', '.join(h['name'] for h in placed))

    if os.path.exists(args.output):
        with open(args.output, encoding='utf-8') as handle:
            existing = json.load(handle)
        differences = compare(existing, payload)
        if differences:
            print('\n%d difference(s) against the existing file:' % len(differences))
            for line in differences[:60]:
                print('   ' + line)
            if len(differences) > 60:
                print('   ... and %d more' % (len(differences) - 60))
        else:
            print('\nidentical to the existing file (ignoring the build timestamp)')

        if args.check:
            sys.exit(1 if differences else 0)

    if not args.check:
        os.makedirs(os.path.dirname(args.output), exist_ok=True)
        with open(args.output, 'w', encoding='utf-8') as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        print('\nwrote %s (%.1f KB)' % (args.output, os.path.getsize(args.output) / 1024))


if __name__ == '__main__':
    main()
