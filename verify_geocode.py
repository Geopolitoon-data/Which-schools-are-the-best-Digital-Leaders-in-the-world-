"""
Check geocoded coordinates before they are written into the workbook.

Two things are verified for every resolved institution:

  1. the country Nominatim reported must be the country the ranking says it
     is in -- a lookup that silently resolved to the wrong country is worse
     than no lookup at all;
  2. the point must not be absurdly far from the other institutions in the
     same country, which catches a right-country-wrong-place result.

Anything that fails, plus anything that never resolved, is written to
geocode_review.csv for a human to look at.
"""
import csv
import json
import math
import os

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE_XLSX = os.path.join(HERE, '..', 'DL_world_map_master_file_all_hubs.xlsx')
CACHE = os.path.join(HERE, 'geocode_cache.json')
REVIEW = os.path.join(HERE, 'geocode_review.csv')

# How Nominatim spells the countries the ranking spells differently.
COUNTRY_ALIASES = {
    'United States of America': ['United States'],
    'Republic of Korea': ['South Korea', '대한민국'],
    'Hong Kong, China': ['Hong Kong', '香港'],
    'Taiwan': ['Taiwan', '臺灣', '台灣'],
    'United Kingdom': ['United Kingdom', 'England', 'Scotland', 'Wales'],
    'Netherlands': ['Netherlands', 'Nederland'],
    'Czechia': ['Czechia', 'Czech Republic'],
}


def country_matches(expected, display_name):
    if not display_name:
        return False
    candidates = COUNTRY_ALIASES.get(expected, [expected])
    tail = display_name.split(',')[-1].strip()
    return any(c.lower() in display_name.lower() or c.lower() == tail.lower()
               for c in candidates)


def haversine(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def main():
    df = pd.read_excel(SOURCE_XLSX)
    with open(CACHE, encoding='utf-8') as handle:
        cache = json.load(handle)

    rows = []
    by_country = {}

    for _, row in df.iterrows():
        name, country = row['institution'], row['country']
        hit = cache.get(name)
        if hit:
            by_country.setdefault(country, []).append((hit['lat'], hit['lon']))

    # Median point per country, as a rough centre to measure against.
    centres = {}
    for country, points in by_country.items():
        lats = sorted(p[0] for p in points)
        lons = sorted(p[1] for p in points)
        centres[country] = (lats[len(lats) // 2], lons[len(lons) // 2])

    unresolved = wrong_country = far = ok = 0

    for _, row in df.iterrows():
        name, country = row['institution'], row['country']
        hit = cache.get(name)

        if not hit:
            unresolved += 1
            rows.append([name, country, '', '', 'NOT RESOLVED', ''])
            continue

        display = hit.get('display_name', '')
        if not country_matches(country, display):
            wrong_country += 1
            rows.append([name, country, hit['lat'], hit['lon'],
                         'WRONG COUNTRY', display])
            continue

        distance = haversine((hit['lat'], hit['lon']), centres[country])
        # 3000 km is generous on purpose: it clears legitimately spread-out
        # countries like the USA and flags only genuine outliers.
        if distance > 3000:
            far += 1
            rows.append([name, country, hit['lat'], hit['lon'],
                         'FAR FROM COUNTRY (%.0f km)' % distance, display])
            continue

        ok += 1

    with open(REVIEW, 'w', newline='', encoding='utf-8-sig') as handle:
        writer = csv.writer(handle)
        writer.writerow(['institution', 'country', 'lat', 'lon', 'issue', 'osm_result'])
        writer.writerows(rows)

    total = len(df)
    print('%d institutions' % total)
    print('  %4d verified in the right country' % ok)
    print('  %4d resolved to the WRONG country' % wrong_country)
    print('  %4d far from the rest of their country' % far)
    print('  %4d never resolved' % unresolved)
    print('\n%d need review -> %s' % (len(rows), os.path.basename(REVIEW)))


if __name__ == '__main__':
    main()
