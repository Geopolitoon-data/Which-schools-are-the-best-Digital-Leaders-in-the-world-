"""
Per-hub quality check.

For every hub, three questions:
  1. who is tagged to it, and how far are they from its centre?
  2. is anyone in the same country sitting inside the hub's radius but NOT
     tagged to it? (a missing member)
  3. does the JSON the map actually loads agree with the workbook?

Run after any change to institutions, coordinates or hub membership.
"""
import io
import json
import math
import os

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
MASTER = os.path.join(HERE, '..', 'DL_world_map_master_file_all_hubs.xlsx')
DATA = os.path.join(HERE, 'data', 'dl-data.json')

from audit_hubs import HUB_RADIUS, EXPLICIT_MEMBERS, haversine   # noqa: E402

MODULES = ['global', 'AI', 'CS', 'transform', 'create']
LABEL = {'global': 'Global', 'AI': 'Data and AI', 'CS': 'Computer Science',
         'transform': 'Digital Transf.', 'create': 'Entrepreneurship'}


def main():
    df = pd.read_excel(MASTER)
    hubs = pd.read_excel(MASTER, sheet_name='Hubs')
    with open(DATA, encoding='utf-8') as handle:
        data = json.load(handle)

    json_hubs = {h['name']: h for h in data['hubs']}
    json_inst = {i['name']: i for i in data['institutions']}

    out = io.StringIO()
    w = lambda s='': out.write(str(s) + '\n')

    problems = []

    w('=' * 78)
    w('HUB QUALITY CHECK — %d hubs, %d institutions' % (len(hubs), len(df)))
    w('=' * 78)

    for _, hub in hubs.iterrows():
        name = hub['Hub Name']
        radius = HUB_RADIUS.get(name)
        members = df[df['Hub Name'] == name]
        country = members['country'].iloc[0] if len(members) else '?'

        w('')
        w('-' * 78)
        w('%s   [%s]   radius %s km' % (name, country, radius))
        w('-' * 78)

        # --- module counts, scored ranks only ---------------------------
        counts = []
        for m in MODULES:
            col = 'rank %s DL26' % m
            n = int(members[col].between(1, 150).sum())
            counts.append('%s %d' % (LABEL[m], n))
        w('  tagged: %d institutions      %s' % (len(members), ' · '.join(counts)))

        # --- members and their distances ---------------------------------
        w('')
        rows = []
        for _, r in members.iterrows():
            d = haversine(hub['Latitude'], hub['Longitude'], r['Latitude'], r['Longitude'])
            rows.append((d, r['institution'], r['rank global DL26']))
        for d, inst, gr in sorted(rows):
            flag = ''
            if radius and d > radius:
                flag = '   <-- OUTSIDE the %d km radius' % radius
                problems.append('%s: %s is %.0f km away' % (name, inst, d))
            rank = '—' if pd.isna(gr) else ('#%d' % gr)
            w('     %6.1f km  %-52s %s%s' % (d, str(inst)[:52], rank, flag))

        # --- anyone nearby who is NOT tagged? ----------------------------
        if radius:
            missing = []
            for _, r in df.iterrows():
                if r['country'] != country:
                    continue
                if pd.notna(r['Hub Name']):
                    continue
                d = haversine(hub['Latitude'], hub['Longitude'], r['Latitude'], r['Longitude'])
                if d <= radius:
                    missing.append((d, r['institution'], r['rank global DL26']))

            if missing:
                explicit = name in EXPLICIT_MEMBERS
                w('')
                w('  NOT TAGGED but within %d km:%s' % (
                    radius, '   (hub has a fixed membership list)' if explicit else ''))
                for d, inst, gr in sorted(missing):
                    rank = '—' if pd.isna(gr) else ('#%d' % gr)
                    w('     %6.1f km  %-52s %s' % (d, str(inst)[:52], rank))
                    if not explicit:
                        problems.append('%s: %s (%.0f km) is not tagged' % (name, inst, d))

        # --- does the map's data agree? ----------------------------------
        # The JSON deliberately leaves out rows the Next 50 brought in, so the
        # comparison is against the counted members, not every tagged row.
        counted = [r for _, r in members.iterrows()
                   if not json_inst.get(r['institution'], {}).get('next50Only')]
        jh = json_hubs.get(name)
        if not jh:
            w('  !! this hub is missing from dl-data.json')
            problems.append('%s missing from the JSON' % name)
        elif jh['institutions'] != len(counted):
            w('  !! JSON says %d institutions, workbook has %d countable'
              % (jh['institutions'], len(counted)))
            problems.append('%s: JSON/workbook disagree' % name)
        if len(counted) != len(members):
            w('  note: %d tagged row(s) excluded as Next 50 only'
              % (len(members) - len(counted)))

    # --- institutions with no hub that maybe should have one -------------
    w('')
    w('=' * 78)
    w('SUMMARY')
    w('=' * 78)
    w('  hubs: %d      tagged institutions: %d' % (len(hubs), df['Hub Name'].notna().sum()))

    untagged_new = [r['institution'] for _, r in df.iterrows()
                    if pd.isna(r['Hub Name'])
                    and json_inst.get(r['institution'], {}).get('next50Only')]
    if untagged_new:
        w('')
        w('  Next 50 additions carrying no hub tag (%d):' % len(untagged_new))
        for n in untagged_new:
            w('     %s' % n)

    w('')
    if problems:
        w('  %d issue(s) found:' % len(problems))
        for p in problems:
            w('     - %s' % p)
    else:
        w('  no issues found')

    path = os.path.join(HERE, 'hub_quality_check.txt')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(out.getvalue())
    print('wrote %s — %d issue(s)' % (os.path.basename(path), len(problems)))


if __name__ == '__main__':
    main()
