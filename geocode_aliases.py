"""
Second geocoding pass for the institutions Nominatim could not find.

Almost every failure is an English exonym: the ranking says "Polytechnic
University of Milan", OpenStreetMap knows it as "Politecnico di Milano".
Each alias below is the institution's own name in its own language, or a
disambiguating city, so the lookup has something real to match.

Run after geocode.py; results are merged into the same cache.
"""
import json
import os
import time

from geocode import CACHE, DELAY_SECONDS, query

ALIASES = {
    'BI Norwegian Business School': 'Handelshøyskolen BI, Oslo',
    'Birla Institute of Technology and Science, Pilani': 'BITS Pilani, Rajasthan',
    'CentraleSupélec - Paris Saclay University': 'CentraleSupélec, Gif-sur-Yvette',
    'Chaitanya Bharathi Institute Of Technology': 'Chaitanya Bharathi Institute of Technology, Hyderabad',
    'China Europe International Business School (CEIBS)': '中欧国际工商学院, Shanghai',
    'ESAN Graduate School Of Business (ESAN University)': 'Universidad ESAN, Lima',
    'ESPM Escola Superior de Propaganda e Marketing': 'ESPM, São Paulo',
    'Ecole Centrale Lyon - Lyon University': 'École Centrale de Lyon, Écully',
    "Ecole Nationale des Ponts et Chaussées - Institut Polytechnique de Paris":
        'École des Ponts ParisTech, Champs-sur-Marne',
    'Ecole Polytechnique - Institut Polytechique de Paris': 'École Polytechnique, Palaiseau',
    'FIA Business School': 'FIA Business School, São Paulo',
    'Free University of Berlin': 'Freie Universität Berlin',
    'IMD Business School': 'IMD, Lausanne',
    'IPADE Business School (Universidad Panamericana)': 'IPADE Business School, Ciudad de México',
    'Karlsruhe Institute of Technology KIT': 'Karlsruher Institut für Technologie',
    "National Technical University of Ukraine 'Kyiv Polytechnic Institute'":
        'Київський політехнічний інститут, Kyiv',
    'Polytechnic University of Catalonia': 'Universitat Politècnica de Catalunya, Barcelona',
    'Polytechnic University of Milan': 'Politecnico di Milano',
    'Ramon Llul University (incl. ESADE)': 'ESADE Business School, Sant Cugat del Vallès',
    'TalTech – Tallinn University of Technology': 'Tallinna Tehnikaülikool',
    'Technical University Darmstadt': 'Technische Universität Darmstadt',
    'Technical University of Berlin': 'Technische Universität Berlin',
    'The University of Adelaide': 'University of Adelaide, South Australia',
    'The University of Texas at Austin (incl. McCombs School of Business)':
        'University of Texas at Austin',
    'The University of Western Ontario': 'Western University, London, Ontario',
    'University of Illinois at Urbana-Champaign': 'University of Illinois Urbana-Champaign',
    'University of Navarra (incl. IESE Business School)': 'Universidad de Navarra, Pamplona',
    'University of Pretoria/Universiteit van Pretoria': 'University of Pretoria',
    'Université Paris-Dauphine - PSL University': 'Université Paris-Dauphine, Paris',
}


# Institutions OpenStreetMap could not place, or placed on the wrong campus.
# These are set by hand to the main campus and marked `manual` in the cache so
# they can be found and checked later. IPADE resolved to its Monterrey campus
# when its principal campus is in Mexico City, so it is overridden here.
MANUAL = {
    'Chaitanya Bharathi Institute Of Technology': (17.3921, 78.3169),   # Gandipet, Hyderabad
    'FIA Business School': (-23.5710, -46.7180),                        # Butantã, São Paulo
    'IPADE Business School (Universidad Panamericana)': (19.4780, -99.1830),  # Mexico City campus
    # Next 50 additions
    'Torcuato Di Tella University': (-34.5462, -58.4494),               # Belgrano, Buenos Aires
    # OSM returns the Medellín campus; the principal campus is Bogotá.
    'Universidad Nacional de Colombia': (4.6381, -74.0838),
}

LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'geocode_aliases_log.txt')


def apply_manual(cache):
    """Fill the last gaps by hand, overriding a wrong-campus result."""
    changed = 0
    # Entries whose automatic result is known to be wrong (right institution,
    # wrong campus) are overridden even when a lookup succeeded.
    WRONG_CAMPUS = {
        'IPADE Business School (Universidad Panamericana)',
        'Universidad Nacional de Colombia',
    }

    for name, (lat, lon) in MANUAL.items():
        existing = cache.get(name)
        if existing and not existing.get('manual') and name not in WRONG_CAMPUS:
            continue
        cache[name] = {
            'lat': lat, 'lon': lon, 'display_name': '(set manually — main campus)',
            'osm_type': 'manual', 'manual': True
        }
        changed += 1
    return changed


def main():
    with open(CACHE, encoding='utf-8') as handle:
        cache = json.load(handle)

    todo = [(name, alias) for name, alias in ALIASES.items() if not cache.get(name)]

    lines = ['%d alias lookups' % len(todo)]
    resolved = 0

    for index, (name, alias) in enumerate(todo, 1):
        try:
            hit = query(alias)
        except Exception as error:                          # noqa: BLE001
            lines.append('   ! %s -- %s' % (alias, error))
            hit = None
        time.sleep(DELAY_SECONDS)

        if hit:
            hit['query'] = alias
            hit['via_alias'] = True
            cache[name] = hit
            resolved += 1
            # Saved as we go: a crash partway through must not throw away
            # lookups already paid for.
            with open(CACHE, 'w', encoding='utf-8') as handle:
                json.dump(cache, handle, indent=1, ensure_ascii=False)

        lines.append('%2d/%2d  %-46s %s' % (
            index, len(todo), alias[:46],
            ('%.4f, %.4f' % (hit['lat'], hit['lon'])) if hit else 'STILL NOT FOUND'))

    manual = apply_manual(cache)
    with open(CACHE, 'w', encoding='utf-8') as handle:
        json.dump(cache, handle, indent=1, ensure_ascii=False)
    lines.append('')
    lines.append('%d coordinates set manually (main campus)' % manual)

    still = [n for n in ALIASES if not cache.get(n)]
    lines.append('')
    lines.append('resolved %d of %d' % (resolved, len(todo)))
    if still:
        lines.append('still unresolved:')
        lines.extend('   ' + n for n in still)

    # Written to a file rather than stdout: the console here is cp1252 and
    # cannot print the non-Latin names in this table.
    with open(LOG, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
    print('resolved %d of %d -- see %s' % (resolved, len(todo), os.path.basename(LOG)))


if __name__ == '__main__':
    main()
