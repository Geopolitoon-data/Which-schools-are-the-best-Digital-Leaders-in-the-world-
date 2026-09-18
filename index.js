/**
 * DIGITAL LEADERS WORLD MAP
 * Main Visualization Entry Point
 *
 * Loads data, initializes D3, manages state and rendering
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Map
  projection: 'equalEarth',
  zoom: { min: 1, max: 24 },   // deep enough to separate a dense city cluster

  // Data
  dataUrl: './data/dl-data.json',
  boundariesUrl: './data/countries-110m.json',

  // Dimensions
  margin: { top: 10, right: 10, bottom: 10, left: 10 },

  // Colors
  countryFill: '#4B5563',
  countryStrokeColor: '#1E1E32',
  countryStrokeWidth: 1,
  unrankedOpacity: 0.3,

  // Animation
  transitionDuration: 250
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const DEFAULT_STATE = {
  // Current selection
  selectedCountry: null,
  selectedHub: null,
  selectedInstitution: null,

  // Filters. Empty arrays mean "no restriction" rather than "nothing".
  selectedModule: 'global',
  selectedEdition: 'DL26',
  filters: {
    types: [],
    rankBand: 'all'      // see RANK_OPTIONS
  },

  // Display
  view: 'country',          // 'country' (choropleth + hubs) or 'institution' (dots)
  showHubs: true,
  showNext50: false,        // when on, the institution view shows the Next 50 INSTEAD of the top 150
  colorMetric: 'dlPoints',  // dlPoints, perCapita, delta, top50Count
  sizeMetric: 'dlPoints'
};

let STATE = { ...DEFAULT_STATE };

// ============================================================================
// DATA LOADING & VALIDATION
// ============================================================================

async function loadData() {
  console.log('[Map] Loading data...');

  try {
    // The standalone build inlines both payloads because a published page
    // cannot fetch anything. Everywhere else they are fetched as normal.
    const embedded = window.DL_EMBEDDED;

    const data = embedded
      ? embedded.data
      : await (async () => {
          const response = await fetch(CONFIG.dataUrl);
          if (!response.ok) throw new Error(`Failed to load data: ${response.statusText}`);
          return response.json();
        })();
    console.log(`[Map] Loaded data:`, {
      schemaVersion: data.schema_version,
      institutions: data.institutions.length,
      countries: data.countries.length,
      regions: data.regions.length,
      hubs: data.hubs.length
    });

    // Validate schema
    if (data.schema_version !== '1.0') {
      throw new Error(`Schema version mismatch: expected 1.0, got ${data.schema_version}`);
    }

    // Validate structure
    ['institutions', 'countries', 'regions', 'hubs'].forEach(key => {
      if (!Array.isArray(data[key])) {
        throw new Error(`Missing or invalid '${key}' array`);
      }
    });

    // Validate institutions have required fields
    data.institutions.forEach((inst, i) => {
      if (!inst.name || inst.latitude === null || inst.longitude === null) {
        throw new Error(`Institution ${i} missing required fields`);
      }
    });

    // Boundary geometry (Natural Earth 110m, TopoJSON)
    const atlas = embedded
      ? embedded.atlas
      : await (async () => {
          const response = await fetch(CONFIG.boundariesUrl);
          if (!response.ok) throw new Error(`Failed to load boundaries: ${response.statusText}`);
          return response.json();
        })();
    data.world = topojson.feature(atlas, atlas.objects.countries);
    console.log(`[Map] Loaded ${data.world.features.length} country polygons`);

    // Fail loudly if the atlas ever stops lining up with our country list,
    // rather than quietly rendering a map with countries missing.
    const atlasNames = new Set(data.world.features.map(f => f.properties.name));
    const unmatched = data.countries
      .map(c => c.name)
      .filter(n => !atlasNames.has(toAtlasName(n)))
      .filter(n => !CITY_STATES_WITHOUT_GEOMETRY.includes(n));
    if (unmatched.length) {
      console.warn('[Map] Countries with no boundary match:', unmatched);
    }

    return data;

  } catch (error) {
    console.error('[Map] Data loading failed:', error);
    throw error;
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init(container) {
  console.log('[Map] Initializing...');

  // Load data
  const data = await loadData();

  // Set up container
  const containerEl = typeof container === 'string'
    ? document.querySelector(container)
    : container;

  if (!containerEl) {
    throw new Error('Container element not found');
  }

  // Drop any previous SVG, but leave sibling overlays (the zoom hint) intact.
  d3.select(containerEl).selectAll('svg').remove();

  // Measure the container. This can legitimately read 0 if we run before the
  // flex layout has settled, so it is only a starting guess — the
  // ResizeObserver set up at the end of init() is what makes the size correct.
  const rect = containerEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width) || 1280);
  const height = Math.max(240, Math.floor(rect.height) || 800);

  console.log(`[Map] Container dimensions: ${width}x${height}`);

  // Create SVG
  const svg = d3.select(containerEl)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('class', 'map-container');

  // Two nested groups: the outer one holds the static margin offset, the inner
  // one is what d3.zoom drives. Keeping them separate means a zoom transform
  // can't clobber the margin.
  const gMargin = svg.append('g')
    .attr('class', 'margin-offset')
    .attr('transform', `translate(${CONFIG.margin.left},${CONFIG.margin.top})`);

  const g = gMargin.append('g').attr('class', 'zoom-layer');

  // Create layer groups (document order sets paint order).
  // Everything geographic goes inside `g` so it zooms and pans together.
  const layers = {
    background: g.append('g').attr('class', 'layer-background'),
    graticule: g.append('g').attr('class', 'layer-graticule'),
    countries: g.append('g').attr('class', 'layer-countries'),
    cityStates: g.append('g').attr('class', 'layer-city-states'),
    rankLabels: g.append('g').attr('class', 'layer-rank-labels'),
    hubs: g.append('g').attr('class', 'layer-hubs'),
    institutions: g.append('g').attr('class', 'layer-institutions'),
    interactive: g.append('g').attr('class', 'layer-interactive')
  };

  // Set up projection
  const projection = getProjection(CONFIG.projection, width - CONFIG.margin.left - CONFIG.margin.right, height - CONFIG.margin.top - CONFIG.margin.bottom);

  // Set up zoom.
  //
  // Plain wheel over the map zooms the map. It used to require ctrl/cmd,
  // which backfired badly: ctrl+wheel is the browser's own page-zoom
  // shortcut, so the gesture meant to zoom the map zoomed the whole page
  // instead. d3 calls preventDefault for wheel events that pass this filter,
  // so the page itself never scrolls or scales.
  //
  // ctrl/cmd+wheel is deliberately handed back to the browser, so anyone who
  // does want to scale the page still can. Drag pans. Double-click zoom stays
  // off because a single click already selects.
  const zoom = d3.zoom()
    .scaleExtent([CONFIG.zoom.min, CONFIG.zoom.max])
    .filter((event) => {
      if (event.type === 'wheel') return !(event.ctrlKey || event.metaKey);
      if (event.type === 'dblclick') return false;
      return !event.button;
    })
    .on('zoom', (event) => {
      // A wheel or drag means the reader has taken over: forget the remembered
      // focus so a later resize restores what they chose, not what we chose.
      if (event.sourceEvent) context.focus = null;

      g.attr('transform', event.transform);
      // Markers are point symbols, not geography — hold their on-screen size.
      g.selectAll('.hub-bubble').attr('r', function () {
        return (+this.getAttribute('data-r') || 0) / event.transform.k;
      });
      g.selectAll('.city-state-halo').attr('r', 7 / event.transform.k);
      g.selectAll('.city-state-dot').attr('r', 4 / event.transform.k);
      g.selectAll('.institution-dot')
        .attr('r', institutionRadius(INSTITUTION_DOT_RADIUS, event.transform.k));
    });

  // Re-run the overlap relaxation once the gesture settles. Doing it on every
  // frame would be wasteful, and the layout only needs to be right when the
  // reader stops moving. As zoom deepens the dots converge on their true
  // coordinates, because the collisions that displaced them stop happening.
  let relaxTimer = null;
  zoom.on('end.relax', () => {
    if (STATE.view !== 'institution') return;
    clearTimeout(relaxTimer);
    relaxTimer = setTimeout(() => {
      drawInstitutions(layers.institutions, context, data, STATE, context.agg);
      rescaleMarkers(context);
    }, 120);
  });

  svg.call(zoom);
  svg.on('dblclick.zoom', null);

  // Store context for rendering
  const context = {
    svg,
    g,
    layers,
    containerEl,
    projection,
    width,
    height,
    data,
    zoom
  };

  // Re-fit whenever the container changes size. This also self-heals the case
  // where the first measurement above happened before layout settled — the
  // observer fires once on attach with the true size.
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => resize(context));
    observer.observe(containerEl);
    context.observer = observer;
  }

  console.log('[Map] Initialization complete');

  return context;
}

/**
 * Re-measure the container, re-fit the projection to it, and redraw.
 * The projection is rebuilt rather than scaled so the map always fills the
 * available box instead of keeping whatever aspect it was born with.
 */
function resize(context) {
  const rect = context.containerEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(240, Math.floor(rect.height));

  if (!width || !height) return;
  if (width === context.width && height === context.height) return;

  context.width = width;
  context.height = height;

  context.svg
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', `0 0 ${width} ${height}`);

  context.projection = getProjection(
    CONFIG.projection,
    width - CONFIG.margin.left - CONFIG.margin.right,
    height - CONFIG.margin.top - CONFIG.margin.bottom
  );

  render(context, STATE, context.data);

  // A zoom transform is in pixels, so it is only meaningful against the
  // projection that produced it. Re-fitting the projection at a new size
  // invalidates it — which is what sent a click on Waterloo to Europe: opening
  // the detail panel narrows the map by 340px, the ResizeObserver reprojects,
  // and the transform computed a moment earlier now points somewhere else.
  // Re-applying the remembered geographic focus puts the view back on target.
  applyFocus(context, 0);
}

/**
 * What the map is currently looking at, in geography rather than pixels, so it
 * can be restored after any reprojection.
 */
function applyFocus(context, duration = CONFIG.transitionDuration) {
  const focus = context.focus;
  if (!focus) return;

  if (focus.type === 'point') {
    applyPointTransform(context, focus.lonLat, focus.scale, duration);
  } else if (focus.type === 'country') {
    applyCountryTransform(context, focus.name, duration);
  }
}

// ============================================================================
// PROJECTION
// ============================================================================

function getProjection(type, width, height) {
  const projections = {
    equalEarth: () => d3.geoEqualEarth()
      .fitSize([width, height], { type: 'Sphere' }),

    orthographic: () => d3.geoOrthographic()
      .fitSize([width, height], { type: 'Sphere' })
      .rotate([0, -25]),

    mercator: () => d3.geoMercator()
      .fitSize([width, height], { type: 'Sphere' })
  };

  const projFn = projections[type] || projections.equalEarth;
  return projFn();
}

// Return the map to the fitted whole-world view.
function resetZoom(context, duration = CONFIG.transitionDuration) {
  context.focus = null;          // back to the whole world; nothing to restore
  context.svg
    .transition()
    .duration(duration)
    .call(context.zoom.transform, d3.zoomIdentity);
}

/** Step the zoom about the centre of the map — what the +/− buttons call. */
function zoomBy(context, factor, duration = 220) {
  context.svg
    .transition()
    .duration(duration)
    .call(context.zoom.scaleBy, factor);
}

// ============================================================================
// COUNTRY NAME RECONCILIATION
// ============================================================================

/**
 * Our country names come from the master Excel; the boundary geometry comes
 * from Natural Earth 110m. 38 of our 41 countries match on name outright.
 * These are the exceptions, established by diffing the two lists.
 */

// Same place, different spelling.
const COUNTRY_NAME_ALIASES = {
  'Republic of Korea': 'South Korea'
};

/**
 * Countries with no polygon at 110m resolution. Hong Kong is absorbed into
 * China's geometry at this scale and Singapore is simply too small to be
 * drawn. Both hold ranked institutions — Singapore is 11th worldwide on DL26
 * points — so they cannot be dropped. They get point markers instead of fills.
 */
const CITY_STATES_WITHOUT_GEOMETRY = ['Hong Kong, China', 'Singapore'];

// Map one of our country names onto its Natural Earth equivalent.
function toAtlasName(countryName) {
  return COUNTRY_NAME_ALIASES[countryName] || countryName;
}

// ============================================================================
// RENDER CONTRACT
// ============================================================================

/**
 * Main render function
 * Called whenever state changes or data updates
 *
 * @param {object} context - SVG, projection, data, layers
 * @param {object} state - Current visualization state
 * @param {object} data - Loaded data (institutions, countries, hubs, regions)
 */
function render(context, state, data) {
  console.log('[Map] Rendering with state:', {
    module: state.selectedModule,
    edition: state.selectedEdition,
    metric: state.colorMetric
  });

  const { layers, projection, width, height } = context;

  // Update state
  STATE = { ...STATE, ...state };

  // Build the colour scale once and hand the same instance to every layer.
  // The polygons and the two city-state markers have to be encoded
  // identically, otherwise the map is quietly inconsistent.
  // Filters recompute the whole map, not just the lists, so everything
  // downstream reads from this one aggregate.
  const agg = buildAggregates(data, STATE);
  context.agg = agg;

  const values = data.countries
    .map(c => countryMetricValue(c, STATE, agg))
    .filter(v => v !== null && !Number.isNaN(v));
  const colorScale = buildColorScale(STATE.colorMetric, values);

  drawSphere(layers.background, projection, context);
  drawGraticule(layers.graticule, projection);
  drawCountries(layers.countries, context, data, STATE, colorScale, agg);

  // City-state markers stand in for countries with no polygon, so they follow
  // the choropleth and switch off with it in the institution view.
  layers.cityStates.style('display', STATE.view === 'institution' ? 'none' : null);
  if (STATE.view !== 'institution') {
    drawCityStates(layers.cityStates, context, data, STATE, colorScale, agg);
  }

  // The leaders wear their position on the map, so "who is first" needs no
  // trip to the key.
  drawRankLabels(layers.rankLabels, context, data, STATE, agg);

  // Hubs belong to the country view; the institution view replaces them with
  // per-institution dots so the two encodings never compete on one map.
  const institutionView = STATE.view === 'institution';

  layers.hubs.style('display', (!institutionView && STATE.showHubs) ? null : 'none');
  if (!institutionView && STATE.showHubs) {
    drawHubs(layers.hubs, context, data, STATE, agg);
  }

  layers.institutions.style('display', institutionView ? null : 'none');
  if (institutionView) {
    drawInstitutions(layers.institutions, context, data, STATE, agg);
  } else {
    layers.institutions.selectAll('circle.institution-dot').remove();
  }

  // Runs whether or not the hub layer is on, so city-state markers keep
  // their on-screen size after any redraw while zoomed in.
  rescaleMarkers(context);

  renderKey(STATE, data, values, colorScale, agg);
  renderBreadcrumb(context, STATE);
  renderDetailPanel(context, STATE, data, agg);

  console.log('[Map] Render complete');
}

// ============================================================================
// FILTERING & AGGREGATION
// ============================================================================

const isFiltered = (state) =>
  state.filters.types.length > 0 ||
  state.filters.rankBand !== 'all';

/**
 * An institution's rank as the country and hub views see it: the scored top
 * 150 only. A Next 50 placing reads as null, because that is what these views
 * saw before the tier was added and none of their figures may move.
 */
function scoredRank(institution, edition, module) {
  const rank = institution.ranks?.[edition]?.[module];
  if (rank === null || rank === undefined) return null;
  return institution.tier?.[edition]?.[module] === 'next50' ? null : rank;
}

function filterInstitutions(data, state) {
  const { types, rankBand } = state.filters;
  const band = RANK_OPTION_BY_ID.get(rankBand) || RANK_OPTION_BY_ID.get('all');

  return data.institutions.filter(institution => {
    if (types.length && !types.includes(institution.type)) return false;

    // The rank cut applies to the ranking currently on screen. Under the
    // Evolution measure that means "of the institutions in today's top N, how
    // did they move" — which is the question worth asking.
    if (band.max !== null) {
      const rank = scoredRank(institution, state.selectedEdition, state.selectedModule);
      if (rank === null || rank > band.max) return false;
    }

    return true;
  });
}

/**
 * Country and hub totals, recomputed from the institutions that survive the
 * filters rather than read from the precomputed aggregates in the JSON.
 *
 * Verified against the pipeline's own numbers: summing (151 − rank) over each
 * country's institutions reproduces every one of the 410 country × edition ×
 * module figures in the file exactly, and every hub figure. So this is the
 * same arithmetic, just applied to a subset.
 */
function buildAggregates(data, state) {
  const kept = filterInstitutions(data, state);
  const module = state.selectedModule;

  const byCountry = new Map();
  const byHub = new Map();

  const bucket = (map, key) => {
    if (!map.has(key)) {
      // `institutions` counts everything present in the current selection;
      // `ranked` counts only those actually ranked in the module on screen,
      // and `byModule` holds that same count for every module. The three are
      // different numbers — the USA has 74 institutions in the file but 44
      // ranked in Data and AI and 62 in Computer Science — and the hover
      // card asks for the module-specific one.
      map.set(key, {
        DL25: 0,
        DL26: 0,
        institutions: 0,
        ranked: 0,          // ranked in the module on screen
        byModule: Object.fromEntries(data.modules.map(m => [m, 0]))
      });
    }
    return map.get(key);
  };

  // The country and hub views must read exactly as they did before the Next 50
  // existed. Only the rows the tier BROUGHT IN are dropped — institutions that
  // merely sit in the Next 50 for Global while ranking normally elsewhere were
  // always in the file, and removing them would change counts that must not
  // move (India would fall from 19 institutions to 13).
  const scored = kept.filter(institution => !institution.next50Only);

  scored.forEach(institution => {
    const country = bucket(byCountry, institution.country);
    const hub = institution.hub ? bucket(byHub, institution.hub) : null;

    country.institutions += 1;
    if (hub) hub.institutions += 1;

    // A Next 50 placing counts as unranked here. Before the tier existed these
    // institutions simply had no Global rank, and that is how this view must
    // continue to see them.
    const currentRank = scoredRank(institution, state.selectedEdition, module);
    if (currentRank !== null) {
      country.ranked += 1;
      if (hub) hub.ranked += 1;
    }

    data.modules.forEach(name => {
      if (scoredRank(institution, state.selectedEdition, name) !== null) {
        country.byModule[name] += 1;
        if (hub) hub.byModule[name] += 1;
      }
    });

    data.editions.forEach(edition => {
      const rank = institution.ranks?.[edition]?.[module];
      const tier = institution.tier?.[edition]?.[module];
      // Belt and braces: Next 50 entries are already excluded above, but
      // scoring one here would give 151 − rank, i.e. a negative — KAUST at
      // #169 would subtract 18 points from Saudi Arabia.
      const points = (rank === null || rank === undefined || tier === 'next50')
        ? 0 : 151 - rank;
      country[edition] += points;
      if (hub) hub[edition] += points;
    });
  });

  // `institutions` is everything that survived the filters, including the
  // Next 50, because the dot layer needs it. `scored` is what the country and
  // hub panels read, so the two views never disagree about who counts.
  return { byCountry, byHub, institutions: kept, scored, active: isFiltered(state) };
}

// ============================================================================
// METRIC ACCESS
// ============================================================================

/**
 * The best-placed institution in a set, for the ranking on screen.
 * Returns null when nothing in the set is ranked there.
 */
function topInstitution(institutions, state) {
  let best = null;
  let bestRank = Infinity;

  institutions.forEach(institution => {
    const rank = scoredRank(institution, state.selectedEdition, state.selectedModule);
    if (rank !== null && rank < bestRank) {
      bestRank = rank;
      best = institution;
    }
  });

  return best ? { institution: best, rank: bestRank } : null;
}

/**
 * What a figure is worth, relative to the rest of the map.
 *
 * "154 DL Points" says nothing on its own. It is only meaningful against
 * something: the leader, the total, or the field. This returns the one line
 * that supplies that, phrased for the measure actually on screen, and is used
 * by both the hover card and the country panel so the two never contextualise
 * the same number differently.
 */
function metricContext(value, state, data, agg, kind = 'country') {
  if (value === null || value === undefined || Number.isNaN(value)) return '';

  const pool = kind === 'hub'
    ? data.hubs.filter(h => agg.byHub.has(h.name))
        .map(h => hubPoints(h, state, agg))
    : data.countries.filter(c => agg.byCountry.has(c.name))
        .map(c => countryMetricValue(c, state, agg));

  const values = pool.filter(v => v !== null && !Number.isNaN(v));
  if (!values.length) return '';

  const max = Math.max(...values);

  if (state.colorMetric === 'delta') {
    // A change is already relative; what it needs is the size of the field
    // it moved within, not a share of a total that can be negative.
    const movers = values.filter(v => v !== 0).length;
    return `${movers} of ${values.length} moved between the editions`;
  }

  if (state.colorMetric === 'perCapita') {
    const median = values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    return `the leader has ${scales.formatDataValue(max, state.colorMetric)}, `
      + `the median ${scales.formatDataValue(median, state.colorMetric)}`;
  }

  const total = values.reduce((sum, v) => sum + v, 0);
  const share = total > 0 ? (value / total) * 100 : 0;
  const shareText = share >= 1 ? share.toFixed(0) : share.toFixed(1);

  return `${shareText}% of the ${Math.round(total).toLocaleString()} DL Points on screen`
    + ` · the leader has ${Math.round(max).toLocaleString()}`;
}

/**
 * Resolve the number a country should be coloured by, for the current
 * module / edition / metric. Returns null when the country has nothing to
 * say for this combination, which callers render as "no data" rather than 0.
 */
function countryMetricValue(country, state, agg) {
  const { selectedEdition, colorMetric } = state;

  // A country with no institutions left after filtering has nothing to say —
  // null, not zero, so it renders as out-of-scope rather than as a low score.
  const totals = agg.byCountry.get(country.name);
  if (!totals) return null;

  const pointsFor = (edition) => totals[edition] ?? null;

  switch (colorMetric) {
    case 'perCapita': {
      const points = pointsFor(selectedEdition);
      if (points === null || !country.population) return null;
      return points / (country.population / 1e6);   // points per million people
    }

    // NOTE on both of these: the divisor has to be an *extensive* quantity
    // (one that grows with the country) or the result still tracks raw size.
    // Dividing by GDP per capita rather than total GDP left the ranking 94%
    // correlated with raw DL Points — a near-duplicate view. Total GDP drops
    // that to 74% and actually surfaces different countries.
    case 'perGdp': {
      const points = pointsFor(selectedEdition);
      if (points === null || !country.gdpPerCapita || !country.population) return null;
      const gdpTrillions = (country.gdpPerCapita * country.population) / 1e12;
      if (!gdpTrillions) return null;
      return points / gdpTrillions;
    }

    // Likewise NRI is an index, not a total, so it is applied to the
    // per-capita figure rather than to the raw points.
    case 'perNri': {
      const points = pointsFor(selectedEdition);
      if (points === null || !country.nriScore || !country.population) return null;
      const perMillion = points / (country.population / 1e6);
      return perMillion / country.nriScore;
    }

    case 'delta': {
      const now = pointsFor('DL26');
      const before = pointsFor('DL25');
      if (now === null && before === null) return null;
      return (now ?? 0) - (before ?? 0);
    }

    default:
      return pointsFor(selectedEdition);
  }
}

// Does this country have a value to show under the current metric?
// Lebanon and Taiwan carry no population, GDP or NRI figures, so the three
// normalised metrics are genuinely undefined for them rather than zero.
function hasMetricValue(country, state, agg) {
  const value = countryMetricValue(country, state, agg);
  return value !== null && !Number.isNaN(value);
}

/**
 * Domain for the colour scale.
 *
 * Momentum is the awkward one: in every module a single country moves 4–7x
 * further than the 90th percentile (India is -421 on Overall against a median
 * absolute change of 16). Scaling to the true extreme paints that one country
 * dark and leaves everyone else indistinguishable near white. So the domain
 * stops at the 90th percentile and saturates beyond it — the legend says so
 * with a ≤ / ≥ on the end labels.
 */
function metricBounds(metric, values) {
  if (!values.length) return { lo: 0, hi: 1, clamped: false };

  if (metric === 'delta') {
    const magnitudes = values.map(Math.abs).sort(d3.ascending);
    const bound = Math.max(1, Math.round(d3.quantile(magnitudes, 0.9) || 1));
    return {
      lo: -bound,
      hi: bound,
      clamped: (d3.max(magnitudes) || 0) > bound
    };
  }

  return { lo: 0, hi: d3.max(values) || 1, clamped: false };
}

function buildColorScale(metric, values) {
  if (!values.length) return () => 'var(--color-navy-light)';

  if (metric === 'delta') {
    const { hi } = metricBounds(metric, values);
    return scales.editionDelta([-hi, hi]);
  }

  // Every non-diverging metric shares the same square-root ramp. They are all
  // long-tailed in the same way — one dominant country and a crowded floor —
  // so they need the same compression to stay readable.
  return scales.dlPointsScale(d3.max(values) || 1);
}

/**
 * The five ways a country can be measured. `label` is what the reader picks
 * from and is named for the question it answers rather than its arithmetic;
 * `legend` is the precise definition shown on the scale; `description` is the
 * plain-language line under the selector.
 */
const METRICS = [
  {
    id: 'dlPoints',
    label: 'Overall strength',
    legend: 'DL Points',
    unit: 'DL Points',
    description: 'Total DL Points. The weight of a country’s ranked universities & schools.'
  },
  {
    id: 'perCapita',
    label: 'Talent density',
    legend: 'DL Points per million people',
    unit: 'DL Points per million people',
    description: 'DL Points against population. Surfaces small countries that rank far above their size.'
  },
  {
    id: 'delta',
    label: 'Evolution',
    legend: 'Change in DL Points, DL25 → DL26',
    unit: 'DL Points, DL25 → DL26',
    description: 'Movement between DL25 and DL26 editions. Green is rising, red is falling.'
  }
];

const METRIC_BY_ID = new Map(METRICS.map(metric => [metric.id, metric]));

const metricMeta = (id) => METRIC_BY_ID.get(id) || METRIC_BY_ID.get('dlPoints');

const MODULE_LABELS = {
  global: 'Global',
  AI: 'Data and AI',
  CS: 'Computer Science',
  transform: 'Digital Transformation',
  create: 'Entrepreneurship'
};

/**
 * What each module actually measures, shown when its filter is clicked.
 * Wording is supplied by Emerging and reproduced verbatim.
 */
const MODULE_DESCRIPTIONS = {
  global: 'The full picture: every ranked institution across all four modules, ' +
          'combined into one global ranking.',
  AI: 'The builders: hands-on AI, data and software engineers/practitioners. ' +
      'Jobs include: Data Engineer, Data Privacy Officer, ML Engineer, Deep Learning Engineer...',
  CS: 'The builders: hands-on AI, data and software engineers/practitioners. ' +
      'Jobs include: Robotics Engineer, Computer Architect, Quantum Computing Engineer...',
  transform: 'The changemakers: leaders running digital transformation in organisations. ' +
             'Jobs include: Head of Change Management, Director of Digitalization, AI Strategy Lead...',
  create: 'The founders: startup founders, C-suite and senior operators. ' +
          'Jobs include: Business Owner, Founding Partner, Chief Innovation Officer...'
};

/**
 * The peer group an institution is compared within.
 *
 * Normally its region — the same regional structure used elsewhere in the
 * Digital Leaders work. Three countries are large and distinctive enough in
 * this ranking to stand as their own group rather than being folded into a
 * continent.
 */
const OWN_GROUP_COUNTRIES = ['India', 'Japan', 'Israel'];

function competitorGroup(institution) {
  return OWN_GROUP_COUNTRIES.includes(institution.country)
    ? { key: 'country:' + institution.country, label: institution.country }
    : { key: 'region:' + institution.region, label: formatRegion(institution.region) };
}

// Competitor scoring. Each is the value at which its half of the score falls
// to 0.5, so they are readable as "30 places apart, or 800 km apart, counts as
// half as close". Surfaced in the panel's method note, so changing them here
// changes the explanation too.
const COMPETITOR_RANK_SCALE = 30;        // places
const COMPETITOR_DISTANCE_SCALE = 800;   // kilometres
const COMPETITOR_RANK_WEIGHT = 0.6;      // remainder goes to distance

/**
 * One colour per module, used for institution dots in the institution view.
 * Drawn from the Emerging palette so the map stays on-brand.
 */
// The Next 50 tier exists for the Global ranking only, matching the pipeline's
// NEXT50_MODULES. Selecting any other ranking has no Next 50 to show.
const NEXT50_MODULES = ['global'];

// The Next 50 is the same orange as Global, lightened. Reading the two tiers
// as one family is the point: these are ranks 151 to 200 of the same ranking,
// not a different kind of thing. Salmon #FF9E79 is the brand's own light
// orange, so the pairing stays inside the palette.
const NEXT50_COLOR = '#FF9E79';

/**
 * One colour per ranking. This map is the single source of truth — the map
 * dots, the legend, the hover breakdown and the institution card all read it,
 * so a change here propagates everywhere.
 *
 * Entrepreneurship and Digital Transformation carry the mauve and green they
 * are given elsewhere in the Digital Leaders work; the other three are
 * unchanged.
 */
const MODULE_COLORS = {
  global: '#FF4901',      // Emerging orange. Global is the headline ranking and
                          // now carries the brand accent; the Next 50 is the
                          // same orange lightened, one tier down.
  AI: '#EFB41C',          // mustard, as Power / AI & Data on the DL site
  CS: '#B87308',          // ochre, a deeper shade of the Data and AI mustard,
                          // since both come from the same Power module
  transform: '#93B23C',   // olive green, as Transform on the DL site
  create: '#9B1FD8'       // violet, as Create on the DL site
};

// ============================================================================
// STATE UPDATES & CONTROLS
// ============================================================================

/**
 * The single way state should change from the UI: merge a patch, redraw,
 * then push the new state back out to the controls so they can't drift out
 * of sync with what the map is actually showing.
 */
function update(context, patch) {
  STATE = { ...STATE, ...patch };
  render(context, STATE, context.data);
  syncControls();
  syncNext50Button();
}

// The elevated surface the explainer popovers sit on, from tokens.css.
// White now, which flips every contrast check below: a brand colour used as
// type on this ground has to be DARKENED, not lifted.
const PANEL_BACKGROUND = '#FFFFFF';

// The hover card's own ground, for the same contrast checks.
const HOVER_BACKGROUND = '#FFFFFF';

/** Relative luminance, for contrast checks. */
function luminance(hex) {
  const channels = [1, 3, 5]
    .map(i => parseInt(hex.substr(i, 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Move a colour just far enough to be readable as text on `background`,
 * preserving its hue.
 *
 * Direction is decided by the background, not assumed. The dark theme only
 * ever needed to LIGHTEN a brand colour; on paper the opposite is true, and
 * lightening here would have walked every module colour toward white on a
 * white panel. So: a light ground darkens the colour, a dark ground lifts it.
 * Mustard #EFB41C measures 1.8:1 on white and has to come down to roughly
 * #7A5A00 before it is type rather than decoration.
 */
function readableOn(colour, background, target = 4.5) {
  const towardBlack = luminance(background) > 0.5;
  let result = colour;
  for (let step = 0; step <= 19 && contrast(result, background) < target; step += 1) {
    const amount = step * 0.05;
    result = '#' + [1, 3, 5].map(i => {
      const value = parseInt(colour.substr(i, 2), 16);
      const moved = towardBlack
        ? value * (1 - amount)
        : value + (255 - value) * amount;
      return Math.round(moved).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }
  return result;
}

// ============================================================================
// CONTROL EXPLAINERS
//
// Every control explains itself, in a popover anchored to the control itself.
//
// This replaces three separate dialogs: a centred modal for DL Points, a
// floating panel for the rankings, and another for the Next 50. All three
// opened somewhere other than where the reader had just clicked, so the
// explanation and the thing being explained were never on screen together.
// One popover, positioned under whichever control asked for it, fixes that,
// and means a new control only has to add an entry below to be documented.
// ============================================================================

/**
 * What each control does, in the reader's terms rather than the data's.
 * `title` heads the popover; `body` is HTML.
 */
const CONTROL_EXPLAINERS = {
  view: {
    title: 'View',
    body: `
      <p><strong>Countries / Hubs</strong> colours every country by its score and
      draws a bubble over each hub, sized by the weight of the institutions in
      it. Use it to read the world.</p>
      <p><strong>Universities &amp; schools</strong> drops the colouring and plots
      every ranked university or school as a single dot where it actually sits.
      Use it to find one.</p>`
  },

  hubs: {
    title: 'Show hubs',
    body: `
      <p>A hub is a city or city-region that concentrates ranked universities &amp;
      schools:
      Greater Boston, the Golden Triangle, Greater Paris, and twelve others.</p>
      <p>The bubble is sized by the DL Points of its members, so the biggest
      circles are the places where the ranking is densest. Turn it off to read
      the country colouring on its own.</p>`
  },

  measure: {
    title: 'Measure',
    body: `
      <p class="pop-lede">DL Points are a simple scoring mechanism that lets you
      compare one country against another, and one institution against another,
      on a single scale.</p>
      <p>They are not a separate ranking or a sixth module. They turn ranking
      positions into a number you can add up.</p>
      <h3>How the score works</h3>
      <p>Each ranking places 150 universities &amp; schools. A school&rsquo;s DL Points
      come from where it sits on that 1 to 150 scale: the higher the position,
      the higher the score.</p>
      <table class="pop-table">
        <tr><th>A school ranked</th><th>scores</th></tr>
        <tr><td>1st</td><td>150 points</td></tr>
        <tr><td>50th</td><td>101 points</td></tr>
        <tr><td>100th</td><td>51 points</td></tr>
        <tr><td>150th</td><td>1 point</td></tr>
      </table>
      <p>A country&rsquo;s score is all of its schools&rsquo; points added together.</p>
      <h3>The three measures</h3>
      <p><strong>Overall strength</strong> is that total.
      <strong>Talent density</strong> divides it by population, asking who does
      most with what they have. <strong>Evolution</strong> compares the DL25 and
      DL26 editions: green is rising, red is falling.</p>`
  },

  rankings: {
    title: 'Rankings',
    body: `
      <p>Five ways to read the same set of universities &amp; schools.
      <strong>Global</strong>
      is the combined ranking; the other four are the areas of the AI and tech
      economy it is built from.</p>
      <p>Pick one and the whole map follows it: the colouring, the dots, the hub
      sizes and every card. Click a ranking a second time to read what it
      covers.</p>`
  },

  next50: {
    title: 'The Next 50',
    body: `
      <p class="pop-lede">A spotlight on the universities &amp; schools ranked
      <strong>151st to 200th in the Global Ranking</strong>, completing the
      <strong>Digital Leaders Global Top 200</strong>.</p>
      <p>Turning this on adds the Next 50 to the Institution view in
      <strong>light orange</strong>, alongside the Top 150 in full orange. The
      Next 50 are also assessed across Data and AI, Computer Science, Digital
      Transformation and Entrepreneurship, with some of them ranking beyond
      the published Top 150 in these areas. <em>However, the Next 50 feature only
      displays them in the Global Ranking Institution view.</em></p>
      <p class="commercial-cta">Want to access their DL Points or benchmark an
      university against its peers?
      <a href="https://emerging.fr/contact" class="cta-link">Contact us</a>.</p>`
  },

  types: {
    title: 'Type',
    body: `
      <p>Narrows the map to one kind of school.</p>
      <p><strong>University (incl. Business School)</strong> covers comprehensive
      universities and business schools.
      <strong>Science &amp; Tech School</strong> covers engineering schools and
      vocational technical or STEM institutions.</p>
      <p>Leave both unticked to see everything. Every figure on screen, including
      the country colouring, is recomputed from what survives the filter.</p>`
  },

  download: {
    title: 'Download dataset',
    body: `
      <p>An Excel workbook of the published dataset, in four sheets:
      <strong>Universities &amp; schools</strong> with every ranking position in
      both editions, <strong>Countries</strong> and <strong>Hubs</strong> with their
      totals, and an <strong>About</strong> sheet explaining the fields.</p>
      <p>It is the complete dataset, not what the filters have narrowed the map
      to. DL Points are given for countries and hubs; per-school points are not published.</p>`
  },

  rank: {
    title: 'Rank band',
    body: `
      <p>Limits the map to the top of the selected ranking: the top 50 or the top
      100, rather than all 150 places.</p>
      <p>It is the quickest way to see where the very best sit, and how much of a
      country&rsquo;s score comes from its strongest few schools rather than from
      depth.</p>`
  }
};

/** Which explainer is open, so a second click on the same control closes it. */
let openPopKey = null;

/**
 * Put the popover under `anchor`, clamped to the viewport.
 *
 * Fixed-position rather than absolute inside the toolbar, so it can overhang
 * the control band and the map without the band needing to grow or scroll.
 */
function positionPop(pop, anchor) {
  const box = anchor.getBoundingClientRect();
  const margin = 12;

  // Measure after the content is in, or the width is the previous panel's.
  const width = pop.offsetWidth;

  let left = box.left;
  if (left + width > window.innerWidth - margin) {
    left = window.innerWidth - width - margin;
  }
  pop.style.left = `${Math.max(margin, left)}px`;
  pop.style.top = `${box.bottom + 8}px`;

  // Cap the height rather than let a long panel run past the fold: these are
  // read in place, not scrolled to.
  pop.style.maxHeight = `${Math.max(180, window.innerHeight - box.bottom - 24)}px`;
}

/** Open the popover against a control. */
function openPop(anchor, { key, title, body, accent }) {
  const pop = document.getElementById('control-pop');
  if (!pop || !anchor) return;

  if (openPopKey === key && !pop.hasAttribute('hidden')) return closePop();

  const heading = pop.querySelector('.pop-title');
  heading.textContent = title;
  heading.style.color = accent ? readableOn(accent, PANEL_BACKGROUND) : '';
  pop.style.borderTopColor = accent || '#1839E2';
  pop.querySelector('.pop-body').innerHTML = body;
  pop.removeAttribute('hidden');

  openPopKey = key;
  positionPop(pop, anchor);
}

function closePop() {
  const pop = document.getElementById('control-pop');
  if (pop) pop.setAttribute('hidden', '');
  openPopKey = null;
}

const isPopOpen = () => {
  const pop = document.getElementById('control-pop');
  return !!pop && !pop.hasAttribute('hidden');
};

/**
 * Turn every `[data-explain]` inside `root` into an info affordance.
 *
 * Controls declare which explainer they carry in the markup, so adding a
 * control to the band is a one-attribute job and nothing has to be registered
 * in script.
 */
function wireExplainers(root = document) {
  root.querySelectorAll('[data-explain]').forEach(button => {
    if (button.dataset.explainWired === 'yes') return;
    button.dataset.explainWired = 'yes';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      explainControl(button, button.dataset.explain);
    });
  });
}

/** Open the standing explainer for a named control. */
function explainControl(anchor, key) {
  const entry = CONTROL_EXPLAINERS[key];
  if (!entry) return;
  openPop(anchor, { key, title: entry.title, body: entry.body });
}

/**
 * The explainer for a ranking, opened against the ranking's own button.
 *
 * Title and top rule carry the ranking's own colour, so the explanation is
 * visibly about the module just clicked. The title is darkened until it clears
 * 4.5:1 on white; the rule takes the colour as-is.
 */
function showModulePanel(module) {
  const anchor = document.querySelector(`.module-button[data-module="${module}"]`);
  const description = MODULE_DESCRIPTIONS[module];
  if (!anchor || !description) return;

  openPop(anchor, {
    key: `module:${module}`,
    title: MODULE_LABELS[module] || module,
    body: `<p>${escapeHtml(description)}</p>`,
    accent: MODULE_COLORS[module] || MODULE_COLORS.global
  });
}

function hideModulePanel() {
  closePop();
}

function showNext50Panel() {
  const entry = CONTROL_EXPLAINERS.next50;
  openPop(document.getElementById('next50-toggle'), {
    key: 'next50',
    title: entry.title,
    body: entry.body,
    accent: NEXT50_COLOR
  });
}

function hideNext50Panel() {
  closePop();
}


/**
 * The Next 50 button reflects two things at once: whether the tier is on, and
 * whether the current view can show it at all. It is dimmed in the country
 * view because the tier deliberately has no effect there.
 */
function syncNext50Button() {
  const button = document.getElementById('next50-toggle');
  if (!button) return;
  button.classList.toggle('is-on', !!STATE.showNext50);
  button.classList.toggle('is-inactive', STATE.view !== 'institution');
  button.setAttribute('aria-pressed', String(!!STATE.showNext50));
  button.title = STATE.view === 'institution'
    ? (STATE.showNext50 ? 'Hide the Next 50' : 'Show the Next 50')
    : 'The Next 50 is shown in the Institution view';
}

/** Keep the view toggle in step when something else changes the view. */
function syncViewButtons(view) {
  document.querySelectorAll('.view-button').forEach(button => {
    button.classList.toggle('is-active', button.dataset.view === view);
  });
}

/**
 * Build the module selector from data.modules rather than a hard-coded list,
 * so adding a module to the pipeline surfaces it here automatically.
 */
function buildModuleSelector(context, mountSelector = '#module-selector') {
  const mount = document.querySelector(mountSelector);
  if (!mount) {
    console.warn(`[Map] No module selector mount at ${mountSelector}`);
    return;
  }

  mount.innerHTML = '';

  context.data.modules.forEach(module => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip module-button';
    button.dataset.module = module;
    button.textContent = MODULE_LABELS[module] || module;
    button.setAttribute('aria-pressed', String(module === STATE.selectedModule));

    // Clicking a ranking both selects it and explains what it covers.
    // Clicking the one already selected just re-opens the explanation.
    button.addEventListener('click', () => {
      if (STATE.selectedModule !== module) {
        update(context, { selectedModule: module });
      }
      showModulePanel(module);
    });

    mount.appendChild(button);
  });

  // The Next 50 extends the Global ranking to 200 places, so it belongs beside
  // Global and nowhere else. It is declared in the markup, outside this mount,
  // because this function clears the mount on every rebuild; moving the node
  // here keeps the listener wired in the bootstrap intact.
  const next50 = document.getElementById('next50-toggle');
  const global = mount.querySelector('.module-button[data-module="global"]');
  if (next50 && global) {
    global.insertAdjacentElement('afterend', next50);
  }

  console.log(`[Map] Module selector built with ${context.data.modules.length} modules`);
}

/**
 * Metric selector. All five measures are available in every audience view —
 * the audience only decides which one you land on.
 */
function buildMetricSelector(context, mountSelector = '#metric-selector') {
  const mount = document.querySelector(mountSelector);
  if (!mount) {
    console.warn(`[Map] No metric selector mount at ${mountSelector}`);
    return;
  }

  mount.innerHTML = '';

  METRICS.forEach(metric => {
    const option = document.createElement('option');
    option.value = metric.id;
    option.textContent = metric.label;
    mount.appendChild(option);
  });

  mount.value = STATE.colorMetric;
  mount.addEventListener('change', (event) => {
    update(context, { colorMetric: event.target.value });
  });

  syncControls();
  console.log(`[Map] Metric selector built with ${METRICS.length} measures`);
}

// ============================================================================
// FILTERS
// ============================================================================

/** Rank bands for the filter. `max` caps the rank shown. */
const RANK_OPTIONS = [
  { id: 'all', label: 'All Ranked', max: null },
  { id: 'top50', label: 'Top 50', max: 50 },
  { id: 'top100', label: 'Top 100 Only', max: 100 }
];

/**
 * Institution types as the interface says them. The workbook's own value is
 * kept as the key — it is Emerging's authoritative field and must not be
 * rewritten — so only the label shown to a reader changes.
 */
const TYPE_LABELS = {
  'University and Business School': 'University (incl. Business School)',
  'Science and Tech School (Engineering School or Vocational Technical/STEM studies)':
    'Science & Tech School'
};

const typeLabel = (type) => TYPE_LABELS[type] || type;

const RANK_OPTION_BY_ID = new Map(RANK_OPTIONS.map(o => [o.id, o]));

/**
 * Filter controls, with their vocabularies read off the data rather than
 * hard-coded — a new institution type in the pipeline shows up here on its own.
 */
function buildFilters(context, mountSelector = '#filters') {
  const mount = document.querySelector(mountSelector);
  if (!mount) return;

  const data = context.data;
  const types = [...new Set(data.institutions.map(i => i.type).filter(Boolean))].sort();

  mount.innerHTML = `
    <div class="filter-group">
      <button class="chip filter-trigger" type="button" data-menu="types">
        Type <span class="filter-badge" data-badge="types"></span>
      </button>
      <div class="filter-menu" data-for="types" hidden>
        ${types.map(t => `
          <label class="filter-option">
            <input type="checkbox" value="${escapeHtml(t)}" data-filter="types">
            <span>${escapeHtml(typeLabel(t))}</span>
          </label>`).join('')}
      </div>
    </div>
    <button class="info-button" type="button" data-explain="types"
            aria-label="What the Type filter does">i</button>

    <select id="rank-filter" class="select-control">
      ${RANK_OPTIONS.map(o => `<option value="${o.id}">${o.label}</option>`).join('')}
    </select>
    <button class="info-button" type="button" data-explain="rank"
            aria-label="What the rank band does">i</button>

    <button id="clear-filters" class="chip is-quiet" type="button" hidden>Clear filters</button>
  `;

  // Each filter explains itself, against itself. Wired here rather than in the
  // bootstrap because this markup is rebuilt from the data.
  wireExplainers(mount);

  // Dropdown open/close
  mount.querySelectorAll('.filter-trigger').forEach(trigger => {
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = mount.querySelector(`.filter-menu[data-for="${trigger.dataset.menu}"]`);
      const opening = menu.hasAttribute('hidden');
      mount.querySelectorAll('.filter-menu').forEach(m => m.setAttribute('hidden', ''));
      if (opening) menu.removeAttribute('hidden');
    });
  });

  document.addEventListener('click', () => {
    mount.querySelectorAll('.filter-menu').forEach(m => m.setAttribute('hidden', ''));
  });
  mount.querySelectorAll('.filter-menu').forEach(menu => {
    menu.addEventListener('click', (event) => event.stopPropagation());
  });

  // Checkbox changes
  mount.querySelectorAll('input[data-filter]').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.filter;
      const selected = [...mount.querySelectorAll(`input[data-filter="${key}"]:checked`)]
        .map(i => i.value);
      update(context, { filters: { ...STATE.filters, [key]: selected } });
    });
  });

  mount.querySelector('#rank-filter').addEventListener('change', (event) => {
    update(context, { filters: { ...STATE.filters, rankBand: event.target.value } });
  });

  mount.querySelector('#clear-filters').addEventListener('click', () => {
    mount.querySelectorAll('input[data-filter]').forEach(i => { i.checked = false; });
    mount.querySelector('#rank-filter').value = 'all';
    update(context, { filters: { types: [], rankBand: 'all' } });
  });

  syncControls();
}

// ============================================================================
// BROWSE
//
// The lists behind the counts in the key. Clicking "41 countries" should
// answer "which 41", and clicking a row in the answer should take you there.
// ============================================================================

/**
 * Rows for one kind of thing, ordered the way the map orders it: by weight,
 * not alphabetically. The reader who opens this list is looking for the head
 * of it, and an A-to-Z buries that.
 *
 * Everything here reads the same aggregates the map does, so an open list
 * always agrees with what is on screen, filters included.
 */
function browseRows(kind, state, data, agg) {
  const points = (value) => Math.round(value || 0).toLocaleString();

  if (kind === 'countries') {
    return data.countries
      .filter(c => agg.byCountry.has(c.name))
      .map(country => {
        const totals = agg.byCountry.get(country.name);
        const value = countryMetricValue(country, state, agg);
        return {
          key: country.name,
          name: country.name,
          meta: formatRegion(country.region),
          figure: value === null || Number.isNaN(value)
            ? '' : scales.formatDataValue(value, state.colorMetric),
          sub: `${totals.ranked} ranked`,
          sort: value === null || Number.isNaN(value) ? -Infinity : value,
          go: { country: country.name }
        };
      })
      .sort((a, b) => b.sort - a.sort);
  }

  if (kind === 'hubs') {
    return data.hubs
      .filter(h => agg.byHub.has(h.name))
      .map(hub => {
        const value = hubPoints(hub, state, agg);
        return {
          key: hub.name,
          name: hub.name,
          meta: hub.country,
          figure: points(value),
          sub: `${hubInstitutionCount(hub, agg)} ranked`,
          sort: value || 0,
          go: { hub: hub.name, country: hub.country,
                point: [hub.longitude, hub.latitude] }
        };
      })
      .sort((a, b) => b.sort - a.sort);
  }

  // Universities and schools, best placed first in the ranking on screen.
  const rankIn = (i) => scoredRank(i, state.selectedEdition, state.selectedModule);

  return agg.scored
    .map(institution => {
      const rank = rankIn(institution);
      return {
        key: institution.id,
        name: institution.name,
        meta: institution.hub
          ? `${institution.country} · ${institution.hub}`
          : institution.country,
        figure: rank === null ? '' : `#${rank}`,
        sub: typeLabel(institution.type) || '',
        sort: rank === null ? Infinity : rank,
        go: { institution: institution.id, country: institution.country,
              point: (institution.longitude != null && institution.latitude != null)
                ? [institution.longitude, institution.latitude] : null }
      };
    })
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

const BROWSE_TITLES = {
  institutions: 'Universities & schools',
  countries: 'Countries',
  hubs: 'Hubs'
};

/** Open the list behind a count. */
function openBrowse(context, kind) {
  const panel = document.getElementById('browse-panel');
  if (!panel) return;

  const state = STATE;
  const data = context.data;
  const agg = buildAggregates(data, state);
  const rows = browseRows(kind, state, data, agg);

  panel.querySelector('.browse-title').textContent =
    `${BROWSE_TITLES[kind] || kind} (${rows.length.toLocaleString()})`;
  panel.querySelector('.browse-sub').textContent =
    `${MODULE_LABELS[state.selectedModule]} · ${metricMeta(state.colorMetric).label}`
    + (agg.active ? ' · filtered' : '');

  const list = panel.querySelector('.browse-list');
  const search = panel.querySelector('.browse-search');

  const paint = (query) => {
    const needle = query.trim().toLowerCase();
    const shown = needle
      ? rows.filter(r => r.name.toLowerCase().includes(needle)
          || r.meta.toLowerCase().includes(needle))
      : rows;

    if (!shown.length) {
      list.innerHTML = '<li class="browse-empty">No matches</li>';
      return;
    }

    list.innerHTML = shown.map((row, index) => `
      <li>
        <button class="browse-row" type="button" data-index="${index}">
          <span class="browse-rank">${escapeHtml(row.figure)}</span>
          <span class="browse-body">
            <span class="browse-name">${escapeHtml(row.name)}</span>
            <span class="browse-meta">${escapeHtml(row.meta)}${
              row.sub ? ` · ${escapeHtml(row.sub)}` : ''}</span>
          </span>
        </button>
      </li>`).join('');

    list.querySelectorAll('.browse-row').forEach(button => {
      button.addEventListener('click', () => {
        goTo(context, shown[+button.dataset.index].go);
        closeBrowse();
      });
    });
  };

  search.value = '';
  paint('');
  search.oninput = () => paint(search.value);

  panel.removeAttribute('hidden');
  list.scrollTop = 0;
  search.focus();
}

/** Select and fly to whatever a browse row points at. */
function goTo(context, target) {
  if (!target) return;

  if (target.institution) {
    update(context, {
      view: 'institution',
      selectedInstitution: target.institution,
      selectedCountry: target.country,
      selectedHub: null
    });
    syncViewButtons('institution');
    if (target.point) return zoomToPoint(context, target.point, 8);
    return zoomToCountry(context, target.country);
  }

  if (target.hub) {
    update(context, {
      view: 'country',
      selectedHub: target.hub,
      selectedCountry: target.country,
      selectedInstitution: null
    });
    syncViewButtons('country');
    return zoomToPoint(context, target.point);
  }

  update(context, {
    view: 'country',
    selectedCountry: target.country,
    selectedHub: null,
    selectedInstitution: null
  });
  syncViewButtons('country');
  zoomToCountry(context, target.country);
}

function closeBrowse() {
  const panel = document.getElementById('browse-panel');
  if (panel) panel.setAttribute('hidden', '');
}

const isBrowseOpen = () => {
  const panel = document.getElementById('browse-panel');
  return !!panel && !panel.hasAttribute('hidden');
};

/**
 * The counts are rebuilt on every render, so the handler lives on the key
 * itself rather than on each button.
 */
function wireBrowse(context) {
  const mount = document.getElementById('map-key');
  if (!mount || mount.dataset.browseWired === 'yes') return;
  mount.dataset.browseWired = 'yes';

  mount.addEventListener('click', (event) => {
    const button = event.target.closest('[data-browse]');
    if (!button) return;
    event.stopPropagation();
    openBrowse(context, button.dataset.browse);
  });
}

// ============================================================================
// DATASET EXPORT
//
// Builds the workbook the Download button hands over. Written to xlsx.js,
// which is a small ZIP-of-XML writer rather than a library, so the page stays
// self-contained and the standalone build keeps working offline.
// ============================================================================

/**
 * What goes in and what stays out.
 *
 * IN: every published ranking position, for both editions, plus the country
 * and hub totals the interface already puts on screen.
 *
 * OUT: DL Points per institution. They are simply 151 minus the rank, so they
 * are not a secret, but publishing them as a column hands over the
 * module-by-module scoring breakdown that the institution card is built to
 * withhold and that the commercial offer rests on. Ranks are exported because
 * the interface already shows every one of them; points per institution are
 * not, because it never does.
 */
function buildExportSheets(data, state) {
  const modules = data.modules;
  const editions = data.editions;
  const edition = state.selectedEdition;

  const rankOf = (institution, ed, module) => {
    const rank = institution.ranks?.[ed]?.[module];
    return (rank === null || rank === undefined) ? null : rank;
  };

  // ---------------------------------------------------------------- about
  const about = {
    name: 'About',
    header: ['Field', 'Value'],
    rows: [
      ['Dataset', 'Digital Leaders 2026, AI & Tech Careers Edition'],
      ['Published by', 'Emerging'],
      ['Exported', new Date().toISOString().slice(0, 10)],
      ['Edition on screen when exported', edition],
      ['Editions included', editions.join(', ')],
      ['Universities & schools', data.institutions.length],
      ['Countries', data.countries.length],
      ['Hubs', data.hubs.length],
      ['Rankings', modules.map(m => MODULE_LABELS[m] || m).join(', ')],
      [],
      ['What a rank means', 'Each ranking places 150 universities & schools. 1 is the best position.'],
      ['The Next 50', 'Universities & schools ranked 151st to 200th in the Global ranking. '
        + 'Shown in the Global ranking only.'],
      ['DL Points', 'A country or hub total: 151 minus the rank, summed over its '
        + 'ranked universities & schools. Per-school DL Points are not published.'],
      ['Scope of this file', 'The complete published dataset. It is not narrowed by '
        + 'the filters that were set on the map.']
    ]
  };

  // --------------------------------------------------------- institutions
  const institutionHeader = ['University or school', 'Country', 'Region', 'Hub', 'Type'];
  editions.forEach(ed => {
    modules.forEach(module => {
      institutionHeader.push(`${MODULE_LABELS[module] || module} rank (${ed})`);
    });
  });
  institutionHeader.push('Global tier (' + edition + ')', 'Latitude', 'Longitude');

  const institutionRows = data.institutions
    .slice()
    .sort((a, b) => {
      // Best Global rank first, then everything unranked in Global by name,
      // so the file opens on the head of the ranking rather than on whatever
      // order the pipeline happened to emit.
      const ra = rankOf(a, edition, 'global');
      const rb = rankOf(b, edition, 'global');
      if (ra === null && rb === null) return a.name.localeCompare(b.name);
      if (ra === null) return 1;
      if (rb === null) return -1;
      return ra - rb;
    })
    .map(institution => {
      const row = [
        institution.name,
        institution.country,
        formatRegion(institution.region),
        institution.hub || '',
        typeLabel(institution.type) || ''
      ];
      editions.forEach(ed => {
        modules.forEach(module => row.push(rankOf(institution, ed, module)));
      });
      row.push(
        institution.tier?.[edition]?.global === 'next50' ? 'Next 50' :
          (rankOf(institution, edition, 'global') !== null ? 'Top 150' : ''),
        institution.latitude ?? null,
        institution.longitude ?? null
      );
      return row;
    });

  // ------------------------------------------------------------ countries
  // Totals are recomputed here from the ranks rather than read off the
  // aggregates, so the file does not change depending on what was filtered
  // on screen at the moment the button was pressed.
  const countryTotals = new Map();
  data.countries.forEach(c => countryTotals.set(c.name, {
    points: Object.fromEntries(editions.map(ed => [ed, 0])),
    ranked: Object.fromEntries(modules.map(m => [m, 0])),
    institutions: 0
  }));

  data.institutions.forEach(institution => {
    const totals = countryTotals.get(institution.country);
    if (!totals || institution.next50Only) return;
    totals.institutions += 1;

    modules.forEach(module => {
      if (scoredRank(institution, edition, module) !== null) totals.ranked[module] += 1;
    });

    editions.forEach(ed => {
      const rank = scoredRank(institution, ed, state.selectedModule);
      if (rank !== null) totals.points[ed] += 151 - rank;
    });
  });

  const countryHeader = ['Country', 'Region', 'Population', 'GDP per capita (USD)',
    'Universities & schools'];
  modules.forEach(m => countryHeader.push(`Ranked in ${MODULE_LABELS[m] || m}`));
  editions.forEach(ed => countryHeader.push(`DL Points, ${MODULE_LABELS[state.selectedModule]} (${ed})`));
  countryHeader.push('Change');

  const countryRows = data.countries
    .map(country => {
      const totals = countryTotals.get(country.name);
      const row = [
        country.name,
        formatRegion(country.region),
        country.population ?? null,
        country.gdpPerCapita ? Math.round(country.gdpPerCapita) : null,
        totals.institutions
      ];
      modules.forEach(m => row.push(totals.ranked[m]));
      editions.forEach(ed => row.push(totals.points[ed]));
      const first = totals.points[editions[0]] || 0;
      const last = totals.points[editions[editions.length - 1]] || 0;
      row.push(last - first);
      return row;
    })
    .sort((a, b) => (b[b.length - 2] || 0) - (a[a.length - 2] || 0));

  // ----------------------------------------------------------------- hubs
  const hubTotals = new Map();
  data.hubs.forEach(h => hubTotals.set(h.name, { institutions: 0, points: 0 }));
  data.institutions.forEach(institution => {
    if (!institution.hub || institution.next50Only) return;
    const totals = hubTotals.get(institution.hub);
    if (!totals) return;
    totals.institutions += 1;
    const rank = scoredRank(institution, edition, state.selectedModule);
    if (rank !== null) totals.points += 151 - rank;
  });

  const hubRows = data.hubs
    .map(hub => [
      hub.name,
      hub.country,
      hubTotals.get(hub.name).institutions,
      hubTotals.get(hub.name).points,
      hub.latitude ?? null,
      hub.longitude ?? null
    ])
    .sort((a, b) => b[3] - a[3]);

  return [
    about,
    { name: 'Universities & schools', header: institutionHeader, rows: institutionRows },
    { name: 'Countries', header: countryHeader, rows: countryRows },
    {
      name: 'Hubs',
      header: ['Hub', 'Country', 'Universities & schools',
        `DL Points, ${MODULE_LABELS[state.selectedModule]} (${edition})`,
        'Latitude', 'Longitude'],
      rows: hubRows
    }
  ];
}

/** Build the workbook and hand it to the browser. */
function exportDataset(context) {
  if (!window.DLXlsx) {
    console.error('[Export] xlsx.js did not load');
    return;
  }
  const sheets = buildExportSheets(context.data, STATE);
  window.DLXlsx.download(sheets,
    `digital-leaders-${STATE.selectedEdition.toLowerCase()}-dataset.xlsx`);
  console.log('[Export] workbook built:',
    sheets.map(s => `${s.name} ${s.rows.length}`).join(', '));
}

// ============================================================================
// SEARCH
// ============================================================================

/**
 * Search across countries, hubs and institutions at once.
 *
 * Choosing an institution flies to that institution's own coordinates and
 * selects it. It used to jump to the institution's hub, or failing that its
 * country, which is why searching MIT landed nowhere near Cambridge.
 */
function buildSearch(context, inputSelector = '#search-input', resultsSelector = '#search-results') {
  const input = document.querySelector(inputSelector);
  const results = document.querySelector(resultsSelector);
  if (!input || !results) return;

  const data = context.data;

  const close = () => {
    results.innerHTML = '';
    results.classList.remove('visible');
  };

  const go = (entry) => {
    input.value = '';
    close();

    if (entry.kind === 'hub') {
      const hub = data.hubs.find(h => h.name === entry.name);
      update(context, {
        view: 'country', selectedHub: hub.name,
        selectedCountry: hub.country, selectedInstitution: null
      });
      syncViewButtons('country');
      return zoomToPoint(context, [hub.longitude, hub.latitude]);
    }

    if (entry.kind === 'institution') {
      const institution = data.institutions.find(i => i.id === entry.id);

      // Fly to the institution itself. Falling back to the country only
      // happens when it genuinely has no coordinates of its own.
      if (institution && institution.latitude != null && institution.longitude != null) {
        update(context, {
          view: 'institution',
          selectedInstitution: institution.id,
          selectedCountry: institution.country,
          selectedHub: null
        });
        syncViewButtons('institution');
        return zoomToPoint(context, [institution.longitude, institution.latitude], 8);
      }

      update(context, {
        view: 'country', selectedCountry: entry.country,
        selectedHub: null, selectedInstitution: null
      });
      syncViewButtons('country');
      return zoomToCountry(context, entry.country);
    }

    update(context, {
      view: 'country', selectedCountry: entry.country,
      selectedHub: null, selectedInstitution: null
    });
    syncViewButtons('country');
    zoomToCountry(context, entry.country);
  };

  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    if (query.length < 2) return close();

    const matches = (name) => name.toLowerCase().includes(query);

    // Rank matches so a short query lands on the obvious answer: an exact
    // name or bracketed acronym first ("MIT", "LSE", "UCL"), then names that
    // start with the query, then anything containing it.
    const score = (name) => {
      const lower = name.toLowerCase();
      const acronyms = (name.match(/\(([^)]+)\)/g) || [])
        .map(a => a.slice(1, -1).toLowerCase());
      if (lower === query || acronyms.includes(query)) return 0;
      if (acronyms.some(a => a.startsWith(query))) return 1;
      if (lower.startsWith(query)) return 2;
      if (new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lower)) return 3;
      return 4;
    };

    const found = [
      ...data.countries.filter(c => matches(c.name))
        .map(c => ({ kind: 'country', name: c.name, country: c.name, meta: 'Country' })),
      ...data.hubs.filter(h => matches(h.name))
        .map(h => ({ kind: 'hub', name: h.name, country: h.country, meta: `Hub · ${h.country}` })),
      ...data.institutions.filter(i => matches(i.name))
        .map(i => ({
          kind: 'institution', id: i.id, name: i.name, country: i.country,
          hub: i.hub, meta: i.hub ? `${i.country} · ${i.hub}` : i.country
        }))
    ].sort((a, b) => score(a.name) - score(b.name)).slice(0, 12);

    if (!found.length) {
      results.innerHTML = '<p class="search-empty">No matches</p>';
      results.classList.add('visible');
      return;
    }

    results.innerHTML = found.map((entry, i) => `
      <button class="search-result" type="button" data-index="${i}">
        <span class="search-result-name">${escapeHtml(entry.name)}</span>
        <span class="search-result-meta">${escapeHtml(entry.meta)}</span>
      </button>`).join('');
    results.classList.add('visible');

    results.querySelectorAll('.search-result').forEach(button => {
      button.addEventListener('click', () => go(found[+button.dataset.index]));
    });
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      close();
      event.stopPropagation();
    }
  });

  document.addEventListener('click', (event) => {
    if (!results.contains(event.target) && event.target !== input) close();
  });
}

function syncControls() {
  document.querySelectorAll('.module-button').forEach(button => {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.module === STATE.selectedModule)
    );
  });

  const metricSelect = document.querySelector('#metric-selector');
  if (metricSelect && metricSelect.value !== STATE.colorMetric) {
    metricSelect.value = STATE.colorMetric;
  }

  // Filter badges show how many options are active in each menu.
  ['types'].forEach(key => {
    const badge = document.querySelector(`[data-badge="${key}"]`);
    if (!badge) return;
    const count = STATE.filters[key].length;
    badge.textContent = count ? String(count) : '';
    badge.classList.toggle('visible', count > 0);
  });

  const clear = document.querySelector('#clear-filters');
  if (clear) clear.toggleAttribute('hidden', !isFiltered(STATE));
}

// ============================================================================
// DRAWING FUNCTIONS (PLACEHOLDERS)
// ============================================================================

function drawSphere(selection, projection, context) {
  selection.selectAll('path.sphere')
    .data([{ type: 'Sphere' }])
    .join('path')
    .attr('class', 'sphere')
    .attr('d', d3.geoPath(projection))
    // Clicking the ocean clears the selection, so there is always an obvious
    // way out of a drill-down without hunting for the close button.
    .on('click', () => {
      if (!STATE.selectedCountry && !STATE.selectedHub) return;
      update(context, { selectedCountry: null, selectedHub: null });
      resetZoom(context);
    });
}

function drawGraticule(selection, projection) {
  selection.selectAll('path.graticule')
    .data([d3.geoGraticule()()])
    .join('path')
    .attr('class', 'graticule')
    .attr('d', d3.geoPath(projection));
}

// ============================================================================
// HOVER CARD
// ============================================================================

/**
 * A styled hover card, shared by countries and hubs.
 *
 * It answers two questions at a glance: how much weight this place carries in
 * the ranking on screen, and how many of its institutions are actually ranked
 * in each module. The per-module counts are the point — they change with the
 * selected ranking, so the USA reads 44 under Data and AI and 62 under
 * Computer Science.
 */
let hoverCardNode = null;

function hoverCard() {
  if (!hoverCardNode) {
    hoverCardNode = document.createElement('div');
    hoverCardNode.className = 'hover-card';
    hoverCardNode.setAttribute('role', 'tooltip');
    hoverCardNode.hidden = true;
    document.body.appendChild(hoverCardNode);
  }
  return hoverCardNode;
}

/**
 * Where an entity places against its peers on the measure currently on screen
 * — countries against countries, hubs against hubs.
 */
function standingOn(entity, kind, state, data, agg) {
  const pool = kind === 'hub'
    ? data.hubs
        .filter(h => agg.byHub.has(h.name))
        .map(h => ({ name: h.name, value: hubPoints(h, state, agg) }))
    : data.countries
        .filter(c => agg.byCountry.has(c.name))
        .map(c => ({ name: c.name, value: countryMetricValue(c, state, agg) }));

  const ordered = pool
    .filter(row => row.value !== null && !Number.isNaN(row.value))
    .sort((a, b) => b.value - a.value);

  const index = ordered.findIndex(row => row.name === entity.name);
  return index === -1 ? null : { rank: index + 1, of: ordered.length };
}

/**
 * The two headline figures follow the selected measure, so the card answers
 * the question the map is currently colouring by — not always DL Points.
 *
 * Every label names the ranking it belongs to. Without that, "45 ranked
 * institutions" gave no clue whether it meant Global or the module the reader
 * had just clicked.
 */
function hoverFigures(entity, kind, state, data, agg) {
  const standing = standingOn(entity, kind, state, data, agg);
  const peers = kind === 'hub' ? 'hubs' : 'countries';

  const value = kind === 'hub'
    ? hubPoints(entity, state, agg)
    : countryMetricValue(entity, state, agg);

  // The module is already stated as a chip above, so these labels say what the
  // number IS, not which ranking it came from.
  const headline = {
    dlPoints: {
      figure: value === null ? '' : Math.round(value).toLocaleString(),
      label: 'DL Points'
    },
    perCapita: {
      figure: value === null ? '' : value.toFixed(1),
      label: 'DL Points per million people'
    },
    delta: {
      // Unsigned: red or green already says which way, and a large signed
      // number reads as a verdict this measure should not be delivering.
      figure: value === null ? '' : Math.abs(Math.round(value)).toLocaleString(),
      label: value === null ? 'DL Points, DL25 → DL26'
        : (value > 0 ? 'DL Points gained since DL25'
          : value < 0 ? 'DL Points lost since DL25' : 'No change since DL25')
    }
  }[state.colorMetric] || {
    figure: value === null ? '' : Math.round(value).toLocaleString(),
    label: 'DL Points'
  };

  const direction = state.colorMetric === 'delta'
    ? (value > 0 ? ' is-up' : value < 0 ? ' is-down' : '') : '';

  const context = metricContext(value, state, data, agg, kind);

  return `
    <div class="hover-figures">
      <div class="hover-figure">
        <span class="hover-points-value${direction}">${headline.figure}</span>
        <span class="hover-points-label">${escapeHtml(headline.label)}</span>
      </div>
      <div class="hover-figure">
        <span class="hover-points-value">${standing ? '#' + standing.rank : ''}</span>
        <span class="hover-points-label">${standing
          ? `of ${standing.of} ${peers}`
          : 'not ranked here'}</span>
      </div>
    </div>
    ${context ? `<p class="hover-context">${escapeHtml(context)}</p>` : ''}`;
}


function hoverCardHtml(entity, kind, subtitle, totals, state, data, agg) {
  const selected = state.selectedModule;

  const rows = data.modules.map(module => {
    const count = totals?.byModule?.[module] ?? 0;
    const active = module === selected;
    return `
      <tr class="${active ? 'is-active' : ''}">
        <td><span class="hover-dot" style="background:${MODULE_COLORS[module]}"></span>${escapeHtml(MODULE_LABELS[module])}</td>
        <td class="hover-count">${count}</td>
      </tr>`;
  }).join('');

  // Name, then where it is, then the ranking being filtered on, then the
  // measure being read — so the figures below arrive already framed.
  return `
    <div class="hover-head">
      <span class="hover-title">${escapeHtml(entity.name)}</span>
      ${subtitle ? `<span class="hover-sub">${escapeHtml(subtitle)}</span>` : ''}
    </div>
    <div class="hover-block">
      <span class="hover-module" style="border-color:${MODULE_COLORS[selected]};
        color:${readableOn(MODULE_COLORS[selected], HOVER_BACKGROUND)}">${escapeHtml(MODULE_LABELS[selected])}</span>
      <p class="hover-measure">${escapeHtml(metricMeta(state.colorMetric).label)}</p>
      ${hoverFigures(entity, kind, state, data, agg)}
    </div>
    <table class="hover-table">
      <caption>Ranked universities &amp; schools</caption>
      ${rows}
    </table>
    <p class="hover-cta">Click to view more information</p>`;
}

function showHoverCard(event, html) {
  const card = hoverCard();
  card.innerHTML = html;
  card.hidden = false;
  moveHoverCard(event);
}

function moveHoverCard(event) {
  const card = hoverCard();
  if (card.hidden) return;

  const pad = 14;
  const { offsetWidth: w, offsetHeight: h } = card;
  let x = event.clientX + pad;
  let y = event.clientY + pad;

  // Keep the card on screen near the right and bottom edges.
  if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;

  card.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}

function hideHoverCard() {
  if (hoverCardNode) hoverCardNode.hidden = true;
}

function drawCountries(selection, context, data, state, colorScale, agg) {
  const path = d3.geoPath(context.projection);

  // Our names come from the Excel, the polygons from Natural Earth; the
  // alias table bridges the two.
  const byAtlasName = new Map(
    data.countries.map(country => [toAtlasName(country.name), country])
  );

  selection.selectAll('path.country')
    .data(data.world.features, d => d.id)
    .join('path')
    .attr('d', path)
    .attr('class', d => {
      const country = byAtlasName.get(d.properties.name);

      // In the institution view the dots carry the data, so the choropleth
      // stands down to a neutral basemap rather than competing with them.
      if (state.view === 'institution') return 'country is-basemap';

      // Not in the ranking at all, or filtered out of it entirely.
      if (!country || !agg.byCountry.has(country.name)) return 'country is-unranked';

      // A country with no figure for this metric must not fall through to the
      // SVG default fill (black) — it gets its own greyed-out state.
      const classes = ['country', 'is-ranked'];
      if (!hasMetricValue(country, state, agg)) classes.push('is-nodata');
      if (country.name === state.selectedCountry) classes.push('active');
      return classes.join(' ');
    })
    .on('click', (event, d) => {
      if (state.view === 'institution') return;   // dots own the interaction
      const country = byAtlasName.get(d.properties.name);
      if (!country) return;
      event.stopPropagation();

      // Clicking the selected country again backs out to the world view.
      const clearing = country.name === STATE.selectedCountry && !STATE.selectedHub;
      update(context, {
        selectedCountry: clearing ? null : country.name,
        selectedHub: null
      });

      if (clearing) resetZoom(context);
      else zoomToCountry(context, country.name);
    })
    .attr('fill', d => {
      if (state.view === 'institution') return null;                     // CSS basemap fill
      const country = byAtlasName.get(d.properties.name);
      if (!country || !hasMetricValue(country, state, agg)) return null;  // CSS fills these
      return colorScale(countryMetricValue(country, state, agg));
    })
    .on('mousemove', (event, d) => {
      if (state.view === 'institution') return hideHoverCard();
      const country = byAtlasName.get(d.properties.name);
      const totals = country && agg.byCountry.get(country.name);
      if (!totals) return hideHoverCard();
      showHoverCard(event, hoverCardHtml(
        country, 'country', formatRegion(country.region), totals, state, data, agg));
    })
    .on('mouseleave', hideHoverCard);
}

/** How many leaders get a badge on the map. */
const RANKED_LABEL_COUNT = 5;

/**
 * Put the leaders' positions on the map itself.
 *
 * Colour alone makes you consult the key and then compare swatches by eye,
 * which is exactly the work a reader should not have to do to answer "who is
 * first". The top five carry their rank as a numbered badge, so the podium is
 * legible in one look and the ramp is left to do what it is good at, which is
 * showing the shape of the field behind them.
 *
 * Five, not ten: beyond that the badges start to crowd Europe, where the
 * countries are small and close together.
 *
 * The badge is drawn inside the zoom layer so it travels with its country,
 * and rescaled by rescaleMarkers() so it does not grow as you zoom in.
 */
function drawRankLabels(selection, context, data, state, agg) {
  selection.selectAll('*').remove();

  // Only the choropleth has a ranking to annotate. In the institution view
  // the dots are the data and a country rank would be answering a question
  // nobody asked.
  if (state.view === 'institution') return;

  const path = d3.geoPath(context.projection);
  const byAtlasName = new Map(
    data.world.features.map(f => [f.properties.name, f])
  );

  const ranked = data.countries
    .filter(c => agg.byCountry.has(c.name) && hasMetricValue(c, state, agg))
    .map(c => ({ country: c, value: countryMetricValue(c, state, agg) }))
    .filter(row => row.value !== null && !Number.isNaN(row.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, RANKED_LABEL_COUNT);

  ranked.forEach((row, index) => {
    // A country's label sits at its projected centroid. City-states have no
    // polygon at this resolution, so they fall back to their own coordinates.
    const feature = byAtlasName.get(toAtlasName(row.country.name));
    let point = null;

    if (feature) {
      point = path.centroid(feature);
    } else if (row.country.longitude != null && row.country.latitude != null) {
      point = context.projection([row.country.longitude, row.country.latitude]);
    }

    if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;

    const group = selection.append('g')
      .attr('class', 'rank-label')
      .attr('data-xy', `${point[0]},${point[1]}`)
      .attr('transform', `translate(${point[0]}, ${point[1]})`);

    group.append('circle')
      .attr('class', 'rank-label-disc')
      .attr('r', 11);

    group.append('text')
      .attr('class', 'rank-label-text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.36em')
      .text(index + 1);
  });
}

/**
 * Singapore and Hong Kong have no polygon at 110m resolution, so they are
 * drawn as markers at their centroids. They use the same colour scale as the
 * choropleth so they read as countries, and sit above the polygons so Hong
 * Kong stays visible on top of China.
 */
function drawCityStates(selection, context, data, state, colorScale, agg) {
  const projection = context.projection;
  const cityStates = data.countries.filter(
    country => CITY_STATES_WITHOUT_GEOMETRY.includes(country.name)
  );

  selection.selectAll('g.city-state')
    .data(cityStates, d => d.name)
    .join(enter => {
      const node = enter.append('g').attr('class', 'city-state');
      node.append('circle').attr('class', 'city-state-halo').attr('r', 7);
      node.append('circle').attr('class', 'city-state-dot').attr('r', 4);
      return node;
    })
    .attr('transform', d => {
      const point = projection([d.coordinates.longitude, d.coordinates.latitude]);
      return `translate(${point[0]},${point[1]})`;
    })
    .on('click', (event, d) => {
      event.stopPropagation();
      const clearing = d.name === STATE.selectedCountry;
      update(context, {
        selectedCountry: clearing ? null : d.name,
        selectedHub: null
      });
      if (clearing) resetZoom(context);
      else zoomToPoint(context, [d.coordinates.longitude, d.coordinates.latitude]);
    })
    .each(function (d) {
      const node = d3.select(this);
      const inScope = agg.byCountry.has(d.name);
      const known = inScope && hasMetricValue(d, state, agg);
      node.classed('is-nodata', inScope && !known);
      node.classed('is-filtered-out', !inScope);
      node.classed('active', d.name === state.selectedCountry);
      node.select('.city-state-dot')
        .attr('fill', known ? colorScale(countryMetricValue(d, state, agg)) : null);
    })
    .on('mousemove', (event, d) => {
      const totals = agg.byCountry.get(d.name);
      if (!totals) return hideHoverCard();
      showHoverCard(event, hoverCardHtml(
        d, 'country', formatRegion(d.region), totals, state, data, agg));
    })
    .on('mouseleave', hideHoverCard);
}

// Read from the filtered aggregate, so hub bubbles shrink and grow with the
// filters exactly as the choropleth does.
const hubPoints = (hub, state, agg) =>
  agg.byHub.get(hub.name)?.[state.selectedEdition] ?? null;

const hubInstitutionCount = (hub, agg) =>
  agg.byHub.get(hub.name)?.institutions ?? 0;


/**
 * Hub bubbles. Size carries DL Points; colour is deliberately uniform so the
 * layer reads as an annotation over the choropleth rather than a second,
 * competing colour encoding.
 */
function drawHubs(selection, context, data, state, agg) {
  const projection = context.projection;
  // A hub with nothing left after filtering disappears rather than sitting
  // there as a zero-radius dot.
  const hubs = data.hubs.filter(h =>
    h.latitude != null && h.longitude != null && hubInstitutionCount(h, agg) > 0);

  const values = hubs.map(h => hubPoints(h, state, agg)).filter(v => v !== null);
  const size = scales.bubbleSize(d3.max(values) || 1);

  selection.selectAll('g.hub')
    .data(hubs, d => d.name)
    .join(enter => {
      const node = enter.append('g').attr('class', 'hub');
      node.append('circle').attr('class', 'hub-bubble');
      return node;
    })
    .attr('transform', d => {
      const point = projection([d.longitude, d.latitude]);
      return `translate(${point[0]},${point[1]})`;
    })
    .classed('active', d => d.name === state.selectedHub)
    .on('click', (event, d) => {
      event.stopPropagation();
      const clearing = d.name === STATE.selectedHub;
      update(context, {
        selectedHub: clearing ? null : d.name,
        selectedCountry: clearing ? STATE.selectedCountry : d.country
      });
      if (!clearing) zoomToPoint(context, [d.longitude, d.latitude]);
    })
    .each(function (d) {
      const radius = size(hubPoints(d, state, agg) || 0);
      const node = d3.select(this);
      // Base radius is stashed so the zoom handler can counter-scale it and
      // keep bubbles a constant size on screen at any zoom level.
      node.select('.hub-bubble').attr('r', radius).attr('data-r', radius);
    })
    .on('mousemove', (event, d) => {
      const totals = agg.byHub.get(d.name);
      if (!totals) return hideHoverCard();
      showHoverCard(event, hoverCardHtml(
        d, 'hub', `${d.country} · hub`, totals, state, data, agg));
    })
    .on('mouseleave', hideHoverCard);
}

// Every institution dot is drawn at this size, in screen pixels at 1× zoom.
// Size carries no meaning here — rank is not encoded in the mark.
const INSTITUTION_DOT_RADIUS = 5;

/**
 * On-screen radius for an institution dot at a given zoom level.
 *
 * Dots are drawn inside the zoom group, so without countering the transform
 * they grow with it — which is why zooming into Europe produced overlapping
 * blobs. Dividing by k alone would hold them at a constant size; they are
 * shrunk a little further as the map magnifies, because zooming in is how you
 * separate a dense cluster and smaller marks separate sooner. Floored so a
 * dot never becomes too small to hit.
 */
function institutionRadius(baseRadius, k) {
  // Dots live inside the zoom group, so what the reader sees is attribute × k.
  // Dividing by k once holds them at a CONSTANT on-screen size at every zoom
  // level.
  //
  // An earlier version shrank them further as the map magnified, on the theory
  // that smaller marks separate sooner. That was the wrong lever: it made the
  // dots hard to see and hit long before a dense cluster came apart. Deeper
  // zoom is what separates overlapping institutions — the geography spreads
  // while the marks stay the same size — so the zoom ceiling does that work
  // now and the dots simply stay legible.
  return baseRadius / k;
}

/**
 * Nudge overlapping institution dots apart.
 *
 * Institutions genuinely sit on top of one another: Delhi University and IIT
 * Delhi share a coordinate exactly, and twenty pairs sit within 2 km — the
 * Paris-Saclay cluster spans 350 m. Zooming cannot fix that on its own, and
 * two dots drawn at the same point read as one institution.
 *
 * The relaxation runs in SCREEN space at the current zoom, so it self-cancels:
 * as you zoom in, real separation grows, collisions stop happening, and the
 * dots settle onto their true coordinates. The displacement only ever exists
 * where dots would otherwise be indistinguishable, and never exceeds a few
 * pixels.
 */
function resolveOverlaps(plotted, projection, k, radius) {
  const nodes = plotted.map(institution => {
    const [px, py] = projection([institution.longitude, institution.latitude]);
    // Work at the scale the reader actually sees.
    return { id: institution.id, tx: px * k, ty: py * k, x: px * k, y: py * k };
  });

  d3.forceSimulation(nodes)
    .force('home-x', d3.forceX(d => d.tx).strength(0.55))
    .force('home-y', d3.forceY(d => d.ty).strength(0.55))
    .force('collide', d3.forceCollide(radius + 0.9).strength(0.9))
    .stop()
    .tick(80);

  // Back into the zoom group's own units.
  return new Map(nodes.map(n => [n.id, [n.x / k, n.y / k]]));
}

/**
 * Institution dots — the institution-level view.
 *
 * One precisely placed dot per institution, coloured by module. Only
 * institutions actually ranked in the module on screen are drawn, so the
 * layer answers "who is ranked here, and where are they" for that ranking
 * rather than showing every row in the file.
 */
function drawInstitutions(selection, context, data, state, agg) {
  const projection = context.projection;
  const module = state.selectedModule;

  // The Next 50 sits alongside the scored ranking rather than replacing it:
  // with the button on you see all 200, the extra fifty picked out in orange.
  const plotted = agg.institutions.filter(institution => {
    if (institution.latitude == null || institution.longitude == null) return false;
    const tier = institution.tier?.[state.selectedEdition]?.[module];
    if (tier === 'top150') return true;
    return tier === 'next50' && state.showNext50;
  });

  const color = MODULE_COLORS[module] || MODULE_COLORS.global;

  const k = d3.zoomTransform(context.svg.node()).k || 1;
  const placed = resolveOverlaps(plotted, projection, k,
                                 institutionRadius(INSTITUTION_DOT_RADIUS, k) * k);

  selection.selectAll('circle.institution-dot')
    .data(plotted, d => d.id)
    .join('circle')
    // Next 50 institutions are drawn in the tier colour: present and
    // clickable, but visibly a different tier from the scored top 150.
    .attr('class', d => 'institution-dot'
      + (d.tier?.[state.selectedEdition]?.[module] === 'next50' ? ' is-next50' : '')
      + (d.id === state.selectedInstitution ? ' active' : ''))
    .attr('cx', d => placed.get(d.id)[0])
    .attr('cy', d => placed.get(d.id)[1])
    // Every dot is the same size. A dot marks where a ranked institution is;
    // its standing is read from the card, not from the mark.
    .attr('r', institutionRadius(INSTITUTION_DOT_RADIUS, k))
    // The Next 50 is picked out in orange so the two tiers separate at a
    // glance while sharing the map. Solid, like the scored dots — the tier is
    // distinguished by hue, not by weight.
    .attr('fill', d => d.tier?.[state.selectedEdition]?.[module] === 'next50'
      ? NEXT50_COLOR : color)
    .on('click', (event, d) => {
      event.stopPropagation();
      const clearing = d.id === STATE.selectedInstitution;
      update(context, {
        selectedInstitution: clearing ? null : d.id,
        selectedCountry: clearing ? null : d.country,
        selectedHub: null
      });
      if (clearing) resetZoom(context);
      else zoomToPoint(context, [d.longitude, d.latitude], 8);
    })
    .on('mousemove', (event, d) => {
      const rank = d.ranks[state.selectedEdition][module];
      const next50 = d.tier?.[state.selectedEdition]?.[module] === 'next50';
      // Rank is the whole message here. The points conversion is deliberately
      // not shown — it belongs behind the score explainer, not on a hover.
      showHoverCard(event, `
        <div class="hover-head">
          <span class="hover-title">${escapeHtml(d.name)}</span>
          <span class="hover-sub">${escapeHtml(d.country)}${d.hub ? ' · ' + escapeHtml(d.hub) : ''}</span>
        </div>
        <p class="hover-rank-line">
          Ranked <strong class="hover-rank">${rank}${next50 ? '' : ' of 150'}</strong>
          in ${escapeHtml(MODULE_LABELS[module])}${next50 ? ' <span class="tier-badge">Next 50</span>' : ''}
        </p>
        <p class="hover-cta">Click to see full details</p>`);
    })
    .on('mouseleave', hideHoverCard);
}

/**
 * Markers are drawn inside the zoom group, so without this they would balloon
 * as you zoom in. Radii are divided by the current zoom factor to hold them
 * at a constant on-screen size.
 */
function rescaleMarkers(context) {
  const k = d3.zoomTransform(context.svg.node()).k || 1;
  context.g.selectAll('.hub-bubble').attr('r', function () {
    return (+this.getAttribute('data-r') || 0) / k;
  });
  context.g.selectAll('.city-state-halo').attr('r', 7 / k);
  context.g.selectAll('.city-state-dot').attr('r', 4 / k);
  context.g.selectAll('.institution-dot')
    .attr('r', institutionRadius(INSTITUTION_DOT_RADIUS, k));

  // The rank badges live in the zoom layer so they follow their country, but
  // they are chrome, not geography: they must stay the same size on screen.
  // Scaling the whole group is one transform instead of two attributes, and
  // keeps the disc and its number in step.
  context.g.selectAll('.rank-label')
    .attr('transform', function () {
      const [x, y] = (this.getAttribute('data-xy') || '0,0').split(',').map(Number);
      return `translate(${x}, ${y}) scale(${1 / k})`;
    });
}

// ============================================================================
// DRILL-DOWN
// ============================================================================

function contentSize(context) {
  return {
    width: context.width - CONFIG.margin.left - CONFIG.margin.right,
    height: context.height - CONFIG.margin.top - CONFIG.margin.bottom
  };
}

function zoomToBounds(context, bounds, fill = 0.7, duration = 650) {
  const [[x0, y0], [x1, y1]] = bounds;
  const { width, height } = contentSize(context);

  const boxWidth = Math.max(x1 - x0, 1);
  const boxHeight = Math.max(y1 - y0, 1);
  const scale = Math.min(
    CONFIG.zoom.max,
    Math.max(CONFIG.zoom.min, fill / Math.max(boxWidth / width, boxHeight / height))
  );

  const transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);

  const target = duration > 0
    ? context.svg.transition().duration(duration)
    : context.svg;
  target.call(context.zoom.transform, transform);
}

// Countries with real geometry zoom to their extent...
function zoomToCountry(context, countryName) {
  context.focus = { type: 'country', name: countryName };
  applyCountryTransform(context, countryName);
}

function applyCountryTransform(context, countryName, duration = 650) {
  const feature = context.data.world.features
    .find(f => f.properties.name === toAtlasName(countryName));

  if (!feature) {
    // ...city-states have no polygon, so fall back to their centroid.
    const country = context.data.countries.find(c => c.name === countryName);
    if (country?.coordinates) {
      applyPointTransform(
        context, [country.coordinates.longitude, country.coordinates.latitude], 6, duration);
    }
    return;
  }

  zoomToBounds(context, d3.geoPath(context.projection).bounds(feature), 0.7, duration);
}

function zoomToPoint(context, lonLat, scale = 6) {
  context.focus = { type: 'point', lonLat, scale };
  applyPointTransform(context, lonLat, scale);
}

function applyPointTransform(context, lonLat, scale = 6, duration = 650) {
  const point = context.projection(lonLat);
  if (!point) return;

  const { width, height } = contentSize(context);
  const transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-point[0], -point[1]);

  const target = duration > 0
    ? context.svg.transition().duration(duration)
    : context.svg;
  target.call(context.zoom.transform, transform);
}

// ============================================================================
// BREADCRUMB
// ============================================================================

function renderBreadcrumb(context, state) {
  const mount = document.getElementById('breadcrumb');
  if (!mount) return;

  const crumbs = [{ label: 'World', target: null }];
  if (state.selectedCountry) {
    crumbs.push({ label: state.selectedCountry, target: 'country' });
  }
  if (state.selectedHub) {
    crumbs.push({ label: state.selectedHub, target: 'hub' });
  }

  mount.innerHTML = crumbs.map((crumb, i) => {
    const isLast = i === crumbs.length - 1;
    const label = escapeHtml(crumb.label);
    return isLast
      ? `<span class="crumb is-current">${label}</span>`
      : `<button class="crumb" type="button" data-target="${crumb.target ?? 'world'}">${label}</button>`;
  }).join('<span class="crumb-sep">›</span>');

  mount.querySelectorAll('.crumb[data-target]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.target === 'world') {
        update(context, { selectedCountry: null, selectedHub: null });
        resetZoom(context);
      } else {
        update(context, { selectedHub: null });
        zoomToCountry(context, STATE.selectedCountry);
      }
    });
  });

  mount.classList.toggle('visible', crumbs.length > 1);
}

/**
 * THE KEY STRIP.
 *
 * This used to be two SVG groups pinned to the bottom-left corner of the map:
 * a gradient legend and a coverage caption. Nobody read either. The bottom-left
 * corner of a map is where the eye arrives last, and on a page this tall it was
 * often below the fold entirely.
 *
 * Both are now HTML, in a strip directly under the control band at the top
 * left, which is where a reader looks to find out how to read what is in front
 * of them. The content is unchanged; only its address is different.
 *
 * It is HTML rather than SVG on purpose. Moving the SVG groups to the top of
 * the map would have collided with the breadcrumb, which already lives there,
 * and would have put the key inside the zoom transform's coordinate space for
 * no gain.
 */
function renderKey(state, data, values, colorScale, agg) {
  const mount = document.getElementById('map-key');
  if (!mount) return;

  const scopeHtml = scopeLine(state, data, agg);

  // The institution view has no choropleth to explain; the key that matters
  // is which ranking the dots represent.
  if (state.view === 'institution') {
    const showingNext50 = state.showNext50
      && NEXT50_MODULES.includes(state.selectedModule);

    const dot = (colour, label) => `
      <li class="key-item">
        <span class="key-dot" style="background:${colour}"></span>
        <span class="key-item-label">${escapeHtml(label)}</span>
      </li>`;

    mount.innerHTML = `
      <p class="key-heading">Ranked in</p>
      <ul class="key-items">
        ${dot(MODULE_COLORS[state.selectedModule],
              MODULE_LABELS[state.selectedModule] + (showingNext50 ? ', top 150' : ''))}
        ${showingNext50 ? dot(NEXT50_COLOR, 'Next 50, ranks 151 to 200') : ''}
      </ul>
      ${scopeHtml}`;
    return;
  }

  if (!values.length) {
    mount.innerHTML = scopeHtml;
    return;
  }

  const { lo, hi, clamped } = metricBounds(state.colorMetric, values);

  // Sample the scale into a CSS gradient so the bar can't drift from the map.
  //
  // `to top`, not `to right`: the bar is vertical now, and a vertical ramp
  // has to run the way a reader expects a quantity to run, with the largest
  // value at the top. The stops are generated low to high either way.
  const steps = 16;
  const stops = d3.range(steps + 1).map(i => {
    const t = i / steps;
    return `${colorScale(lo + t * (hi - lo))} ${(t * 100).toFixed(0)}%`;
  }).join(', ');

  // A leading <= or >= tells the reader the ends of the ramp are saturated
  // rather than being the true extremes of the data.
  const lowLabel = (clamped ? '\u2264 ' : '') + scales.formatDataValue(lo, state.colorMetric);
  const highLabel = (clamped ? '\u2265 ' : '') + scales.formatDataValue(hi, state.colorMetric);

  // Only advertise a "no figures" key when some ranked country actually
  // lacks a value for the metric on screen.
  const missing = data.countries
    .filter(c => agg.byCountry.has(c.name) && !hasMetricValue(c, state, agg)).length;

  mount.innerHTML = `
    <p class="key-heading">${escapeHtml(MODULE_LABELS[state.selectedModule])}</p>
    <p class="key-subheading">${escapeHtml(metricMeta(state.colorMetric).legend)}</p>

    <div class="key-scale">
      <span class="key-ramp" style="background:linear-gradient(to top, ${stops})"></span>
      <span class="key-ticks">
        <span class="key-tick">${escapeHtml(highLabel)}</span>
        <span class="key-tick">${escapeHtml(lowLabel)}</span>
      </span>
    </div>

    <ul class="key-items">
      <li class="key-item">
        <span class="key-swatch key-swatch-unranked"></span>
        <span class="key-item-label">Not ranked</span>
      </li>
      ${missing > 0 ? `
      <li class="key-item">
        <span class="key-swatch key-swatch-nodata"></span>
        <span class="key-item-label">No figures available (${missing})</span>
      </li>` : ''}
    </ul>

    ${scopeHtml}`;
}

// ============================================================================
// DETAIL PANEL
// ============================================================================

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Where a country sits on a given measure, among the countries that have a
 * figure for it. Recomputed per measure so the denominator is honest — the
 * normalised measures exclude Lebanon and Taiwan, and saying "of 41" there
 * would be wrong.
 */
function countryRank(country, metricId, data, state, agg) {
  const probe = { ...state, colorMetric: metricId };
  const ordered = data.countries
    .map(c => ({ name: c.name, value: countryMetricValue(c, probe, agg) }))
    .filter(row => row.value !== null && !Number.isNaN(row.value))
    .sort((a, b) => b.value - a.value);

  const index = ordered.findIndex(row => row.name === country.name);
  return index === -1 ? null : { rank: index + 1, of: ordered.length };
}

function renderDetailPanel(context, state, data, agg) {
  const panel = document.getElementById('detail-panel');
  if (!panel) return;

  // An institution selection takes precedence: in the institution view the
  // card is about that institution, not the country it happens to sit in.
  const institution = state.selectedInstitution
    ? data.institutions.find(i => i.id === state.selectedInstitution)
    : null;

  if (institution) {
    renderInstitutionPanel(panel, context, state, data, institution, agg);
    return;
  }

  const hub = state.selectedHub
    ? data.hubs.find(h => h.name === state.selectedHub)
    : null;

  if (hub) {
    renderHubPanel(panel, context, state, data, hub, agg);
    return;
  }

  const country = data.countries.find(c => c.name === state.selectedCountry);

  if (!country) {
    panel.classList.remove('visible');
    panel.innerHTML = '';
    return;
  }

  const edition = state.selectedEdition;
  const moduleLabel = MODULE_LABELS[state.selectedModule];

  // Every measure, not just the one being coloured — the panel is where the
  // reader compares a country against itself.
  const measureRows = METRICS.map(metric => {
    const probe = { ...state, colorMetric: metric.id };
    const value = countryMetricValue(country, probe, agg);
    const known = value !== null && !Number.isNaN(value);
    const position = known ? countryRank(country, metric.id, data, state, agg) : null;

    return `
      <tr${metric.id === state.colorMetric ? ' class="is-current"' : ''}>
        <td>${escapeHtml(metric.label)}</td>
        <td class="value">${known ? escapeHtml(scales.formatDataValue(value, metric.id)) : ''}</td>
        <td class="rank">${position ? `#${position.rank}<span class="of"> of ${position.of}</span>` : ''}</td>
      </tr>`;
  }).join('');

  const institutions = agg.scored.filter(i => i.country === country.name);

  // Hubs inside this country, offered as the next step down.
  const hubs = data.hubs
    .filter(h => h.country === country.name && hubInstitutionCount(h, agg) > 0)
    .sort((a, b) => (hubPoints(b, state, agg) || 0) - (hubPoints(a, state, agg) || 0));

  const hubsSection = hubs.length ? `
    <h3 class="panel-section">Hubs<span class="panel-count">${hubs.length}</span></h3>
    <ul class="hub-list">
      ${hubs.map(h => {
        const count = hubInstitutionCount(h, agg);
        return `
        <li>
          <button class="hub-link" type="button" data-hub="${escapeHtml(h.name)}">
            <span class="hub-link-name">${escapeHtml(h.name)}</span>
            <span class="hub-link-meta">${count} ranked · ${Math.round(hubPoints(h, state, agg) || 0).toLocaleString()} pts</span>
          </button>
        </li>`;
      }).join('')}
    </ul>` : '';

  // Size and wealth only. NRI and income group were dropped — they backed the
  // two measures that have been retired, and said nothing on their own.
  const enrichment = [
    country.population ? `${(country.population / 1e6).toFixed(1)}M people` : null,
    country.gdpPerCapita ? `$${Math.round(country.gdpPerCapita).toLocaleString()} GDP per capita` : null
  ].filter(Boolean).join(' · ');

  // The country's best school, named. A score is abstract; the institution
  // behind it is the thing a reader recognises, and it is the first question
  // anyone asks of a country on this map.
  const best = topInstitution(institutions, state);
  const leadHtml = best ? `
    <div class="panel-lead">
      <span class="panel-lead-label">Top ranked in ${escapeHtml(moduleLabel)}</span>
      <span class="panel-lead-name">${escapeHtml(best.institution.name)}</span>
      <span class="panel-lead-rank">#${best.rank} in the world</span>
    </div>` : '';

  const headline = countryMetricValue(country, state, agg);
  const contextLine = metricContext(headline, state, data, agg, 'country');

  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">${escapeHtml(country.name)}</h2>
        <p class="panel-subtitle">${escapeHtml(formatRegion(country.region))}</p>
      </div>
      <button class="panel-close" type="button" aria-label="Close">×</button>
    </div>

    ${enrichment ? `<p class="panel-enrichment">${escapeHtml(enrichment)}</p>` : ''}

    ${leadHtml}

    <h3 class="panel-section">${escapeHtml(moduleLabel)} · how it measures up</h3>
    <table class="measure-table">${measureRows}</table>
    ${contextLine ? `<p class="panel-context">${escapeHtml(contextLine)}</p>` : ''}

    ${countrySections(country, state, data, agg)}

    ${hubsSection}

    ${institutionSection(institutions, state)}
  `;

  panel.classList.add('visible');
  panel.scrollTop = 0;

  panel.querySelector('.panel-close')
    .addEventListener('click', () => {
      update(context, { selectedCountry: null, selectedHub: null });
      resetZoom(context);
    });

  panel.querySelectorAll('.hub-link').forEach(button => {
    button.addEventListener('click', () => {
      const hub = data.hubs.find(h => h.name === button.dataset.hub);
      if (!hub) return;
      update(context, { selectedHub: hub.name, selectedCountry: hub.country });
      zoomToPoint(context, [hub.longitude, hub.latitude]);
    });
  });
}

/**
 * Institution list, best rank first in the module on screen. Institutions
 * absent from that particular ranking are still listed, under a divider, so
 * a country's full footprint stays visible instead of being silently cut.
 */
function institutionSection(institutions, state) {
  // Scored ranks only: a Next 50 placing falls into "Not in this ranking",
  // which is where these institutions sat before the tier was introduced.
  const rankIn = (i) => scoredRank(i, state.selectedEdition, state.selectedModule);

  const sortByRank = (a, b) => rankIn(a) - rankIn(b);

  // Only two groups here. The Next 50 never reaches the country view at all,
  // so it needs no heading in this list.
  const scored = institutions.filter(i => rankIn(i) !== null).sort(sortByRank);
  const unranked = institutions
    .filter(i => rankIn(i) === null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const row = (institution) => {
    const rank = rankIn(institution);
    return `
      <li class="institution${rank === null ? ' is-unranked' : ''}">
        <span class="institution-rank">${rank === null ? '' : rank}</span>
        <span class="institution-body">
          <span class="institution-name">${escapeHtml(institution.name)}</span>
          <span class="institution-type">${escapeHtml(typeLabel(institution.type) || '')}</span>
        </span>
      </li>`;
  };

  return `
    <h3 class="panel-section">
      Universities &amp; schools in ${escapeHtml(MODULE_LABELS[state.selectedModule])}
      <span class="panel-count">${scored.length} of ${institutions.length} ranked</span>
    </h3>
    <ul class="institution-list">
      ${scored.map(row).join('')}
      ${unranked.length ? '<li class="institution-divider">Not in this ranking</li>' : ''}
      ${unranked.map(row).join('')}
    </ul>`;
}

// ============================================================================
// AUDIENCE SECTIONS
// ============================================================================

/** Points per module for a set of institutions, in one edition. */
function modulePoints(institutions, edition, modules) {
  const totals = Object.fromEntries(modules.map(m => [m, 0]));
  institutions.forEach(institution => {
    modules.forEach(module => {
      const rank = institution.ranks?.[edition]?.[module];
      if (rank !== null && rank !== undefined) totals[module] += 151 - rank;
    });
  });
  return totals;
}

/** Horizontal bars, scaled against the largest value in the set. */
function barList(rows, formatValue = (v) => Math.round(v).toLocaleString()) {
  const max = Math.max(...rows.map(r => r.value), 1);
  return `<ul class="bar-list">${rows.map(row => `
    <li class="bar-row${row.highlight ? ' is-highlight' : ''}">
      <span class="bar-label">${escapeHtml(row.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(row.value / max) * 100}%"></span></span>
      <span class="bar-value">${escapeHtml(formatValue(row.value))}</span>
    </li>`).join('')}</ul>`;
}

/**
 * Regions are stored lowercase ("western europe"); display them title-cased.
 * "mena" is an acronym, not a word, so title-casing alone gives "Mena".
 */
const REGION_LABELS = { mena: 'MENA' };

function formatRegion(region) {
  if (!region) return '';
  const key = String(region).toLowerCase();
  return REGION_LABELS[key]
    || String(region).replace(/\b[a-z]/g, char => char.toUpperCase());
}

/** Countries in the same region, ordered by the measure on screen. */
function regionPeers(country, data, state, agg) {
  return data.countries
    .filter(c => c.region === country.region && agg.byCountry.has(c.name))
    .map(c => ({ name: c.name, value: countryMetricValue(c, state, agg) }))
    .filter(row => row.value !== null && !Number.isNaN(row.value))
    .sort((a, b) => b.value - a.value);
}

/**
 * The analysis sections of the country panel: how its DL Points split across
 * the four rankings, how it compares with its neighbours, how it moved
 * between editions, and what kinds of institution make it up.
 */
function countrySections(country, state, data, agg) {
  const modules = data.modules;
  const institutions = agg.scored.filter(i => i.country === country.name);
  const totals = agg.byCountry.get(country.name);

  // --- Field mix, as a share of the country's points ----------------------
  // Shown as percentages rather than raw points: the question here is what
  // this country is made of, not how big it is. Global is excluded because it
  // is the combination of the other four, not a fifth field alongside them.
  const fields = modules.filter(m => m !== 'global');
  const byModule = modulePoints(institutions, state.selectedEdition, fields);
  const fieldTotal = fields.reduce((sum, m) => sum + byModule[m], 0);

  const fieldMix = fieldTotal > 0 ? `
    <h3 class="panel-section">Field mix</h3>
    ${barList(
      fields.map(m => ({
        label: MODULE_LABELS[m],
        value: (byModule[m] / fieldTotal) * 100,
        highlight: m === state.selectedModule
      })).sort((a, b) => b.value - a.value),
      v => v.toFixed(0) + '%'
    )}
    <p class="panel-note">Share of this country’s DL Points across the four rankings.</p>` : '';

  // --- Nearby in the region -----------------------------------------------
  const peers = regionPeers(country, data, state, agg);
  const ownIndex = peers.findIndex(p => p.name === country.name);
  const around = peers.slice(Math.max(0, ownIndex - 2), ownIndex + 3);

  const nearby = peers.length > 1 ? `
    <h3 class="panel-section">Nearby in ${escapeHtml(formatRegion(country.region) || 'the region')}</h3>
    ${barList(around.map(p => ({
      label: p.name, value: p.value, highlight: p.name === country.name
    })), v => scales.formatDataValue(v, state.colorMetric))}` : '';

  // --- Movement between the two editions ----------------------------------
  // Direction is carried by colour and by the word, not by a large signed
  // number: this reading is contestable and should not present itself as the
  // headline conclusion about a country.
  const change = totals ? totals.DL26 - totals.DL25 : 0;
  const direction = change > 0 ? 'Rising' : change < 0 ? 'Falling' : 'Unchanged';
  const movement = `
    <h3 class="panel-section">Movement since DL25</h3>
    <p class="panel-note big-number ${change > 0 ? 'is-up' : change < 0 ? 'is-down' : ''}">
      ${direction}${change === 0 ? '' : ` · ${Math.abs(Math.round(change)).toLocaleString()} DL Points`}
    </p>
    <p class="panel-note">
      ${escapeHtml(MODULE_LABELS[state.selectedModule])}, DL25 → DL26.
    </p>`;

  // --- Institution mix ----------------------------------------------------
  const typeCounts = {};
  institutions.forEach(i => {
    if (i.type) typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
  });

  const institutionMix = Object.keys(typeCounts).length ? `
    <h3 class="panel-section">Institution mix</h3>
    ${barList(Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => ({ label: type, value: n })), v => String(v))}` : '';

  return fieldMix + nearby + movement + institutionMix;
}

/**
 * The card for a single institution.
 *
 * Deliberately narrow: who it is, where it is, the rankings it actually
 * appears in, and its nearest geographic rivals in the ranking on screen.
 *
 * Movement is shown only when it is upward. A ranking is a public statement
 * about an institution, and there is no reason for this map to be the thing
 * that announces a fall — so a decline is simply not drawn, rather than drawn
 * in red.
 */
function renderInstitutionPanel(panel, context, state, data, institution, agg) {
  const edition = state.selectedEdition;

  // Only the rankings this institution is actually in.
  const ranked = data.modules
    .map(module => ({ module, rank: institution.ranks?.[edition]?.[module] }))
    .filter(row => row.rank !== null && row.rank !== undefined)
    .sort((a, b) => a.rank - b.rank);

  // Ranking and position only. The per-module points conversion is
  // deliberately absent: the module-level breakdown is the commercial
  // product, and the card gives a single comparable total instead.
  const rankingRows = ranked.map(row => {
    const next50 = institution.tier?.[edition]?.[row.module] === 'next50';
    return `
    <tr${row.module === state.selectedModule ? ' class="is-current"' : ''}>
      <td><span class="hover-dot" style="background:${MODULE_COLORS[row.module]}"></span>${escapeHtml(MODULE_LABELS[row.module])}</td>
      <td class="rank">${next50 ? `#${row.rank} <span class="tier-badge">Next 50</span>` : `#${row.rank}`}</td>
    </tr>`;
  }).join('');

  // One number an institution can compare against another, summed across the
  // rankings it is placed in. Next 50 placings score nothing, so they add
  // nothing here either.
  const totalPoints = data.modules.reduce((sum, module) => {
    const rank = institution.ranks?.[edition]?.[module];
    const tier = institution.tier?.[edition]?.[module];
    return sum + ((rank && tier !== 'next50') ? (151 - rank) : 0);
  }, 0);

  // --- Closest competitors ------------------------------------------------
  //
  // Competitors come from the institution's own peer group — its region, or
  // its country where that country stands alone (India, Japan, Israel) — and
  // must be the same kind of institution.
  //
  // Within the group, a competitor is one that is near in the ranking *and*
  // near geographically. Rank alone would pair institutions at opposite ends
  // of a continent; distance alone returns whoever shares a city regardless of
  // standing — MIT's nearest neighbours by kilometre sit a hundred places
  // below it, which nobody would call a competitor.
  //
  // Both terms are normalised to 0–1 and combined, so an institution 40 places
  // away in the table has to be much closer geographically to place above one
  // sitting a few ranks apart.
  const module = state.selectedModule;
  const ownRank = institution.ranks?.[edition]?.[module];

  const RANK_SCALE = COMPETITOR_RANK_SCALE;
  const DISTANCE_SCALE = COMPETITOR_DISTANCE_SCALE;
  const group = competitorGroup(institution);

  const competitors = (institution.latitude == null || ownRank == null ? [] : data.institutions
    .filter(other => {
      if (other.id === institution.id) return false;
      if (competitorGroup(other).key !== group.key) return false;
      // Like competes with like: a business school is not a peer of an
      // engineering school just because they share a region.
      if (other.type !== institution.type) return false;
      if (other.latitude == null || other.longitude == null) return false;
      const rank = other.ranks?.[edition]?.[module];
      return rank !== null && rank !== undefined;
    })
    .map(other => {
      const rank = other.ranks[edition][module];
      const km = distanceKm(institution.latitude, institution.longitude,
                            other.latitude, other.longitude);
      const rankGap = Math.abs(rank - ownRank);

      // Each term is a soft 0–1 closeness score rather than a hard cutoff, so
      // one very good match on either axis can still surface.
      const rankCloseness = 1 / (1 + rankGap / RANK_SCALE);
      const nearness = 1 / (1 + km / DISTANCE_SCALE);

      return {
        institution: other, rank, km, rankGap,
        score: rankCloseness * COMPETITOR_RANK_WEIGHT
             + nearness * (1 - COMPETITOR_RANK_WEIGHT)
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5));

  const competitorRows = competitors.map(entry => `
    <li class="competitor">
      <button class="competitor-link" type="button" data-institution="${escapeHtml(entry.institution.id)}">
        <span class="competitor-name">${escapeHtml(entry.institution.name)}</span>
        <span class="competitor-meta">${escapeHtml(entry.institution.hub
          || entry.institution.country)} · ${formatDistance(entry.km)}</span>
      </button>
      <span class="competitor-rank">#${entry.rank}</span>
    </li>`).join('');

  // --- Evolution, upward only ---------------------------------------------
  const previous = institution.ranks?.DL25?.[module];
  const improved = ownRank !== null && ownRank !== undefined
    && previous !== null && previous !== undefined
    && ownRank < previous;

  const evolution = improved ? `
    <h3 class="panel-section">Evolution</h3>
    <p class="panel-note rising">
      <span class="rising-arrow" aria-hidden="true">▲</span>
      Rising in ${escapeHtml(MODULE_LABELS[module])} since DL25
    </p>` : '';

  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">${escapeHtml(institution.name)}</h2>
        <p class="panel-subtitle">${escapeHtml(institution.country)} · ${escapeHtml(formatRegion(institution.region))}</p>
      </div>
      <button class="panel-close" type="button" aria-label="Close">×</button>
    </div>

    ${institution.hub ? `<p class="panel-enrichment">${escapeHtml(institution.hub)}</p>` : ''}

    ${ranked.length ? `
      <h3 class="panel-section">DL26 rankings</h3>
      <table class="measure-table ranking-table">
        <thead><tr><th>Ranking</th><th class="rank">Rank</th></tr></thead>
        <tbody>${rankingRows}</tbody>
      </table>

      <div class="total-points">
        <div class="total-points-head">
          <span class="total-points-label">Total DL Points</span>
          <button class="score-info" type="button" aria-label="What does this score mean?"
                  aria-expanded="false">What does this score mean?</button>
        </div>
        <span class="total-points-value">${totalPoints.toLocaleString()}</span>
        <div class="score-explainer" hidden>
          <p>
            DL Points make institutions directly comparable on one scale.
          </p>
          <p>
            Each ranking places 150 institutions, and the score is calculated
            from where an institution sits on that 1&ndash;150 scale: the higher the
            position, the higher the score. Adding those together gives a single
            number you can set against any other institution, or against a
            country&rsquo;s total.
          </p>
        </div>
        <p class="commercial-cta">
          <strong>For institutions:</strong> Access your detailed DL Points and key
          insights. <a href="https://emerging.fr/contact" class="cta-link">Contact us</a>.
        </p>
      </div>` : ''}

    ${evolution}

    ${competitorRows ? `
      <h3 class="panel-section">Closest competitors<span class="panel-count">${escapeHtml(group.label)}</span></h3>
      <ul class="competitor-list">${competitorRows}</ul>
      <details class="method">
        <summary>How these are chosen</summary>
        <p>
          Competitors are institutions of the same kind
         : <strong>${escapeHtml(typeLabel(institution.type))}</strong> 
          within <strong>${escapeHtml(group.label)}</strong>. An institution is
          compared inside its own region, except in India, Japan and Israel,
          which each form a group of their own.
        </p>
        <p>
          Within that group, a competitor is close on <strong>both</strong>
          counts: near in the ${escapeHtml(MODULE_LABELS[module])} ranking, and
          near geographically. Each gets two closeness scores between 0 and 1 
        </p>
        <p class="method-formula">
          rank closeness = 1 ÷ (1 + places apart ÷ ${RANK_SCALE})<br>
          distance closeness = 1 ÷ (1 + km apart ÷ ${DISTANCE_SCALE})
        </p>
        <p>
         : which are combined as
          <strong>${Math.round(COMPETITOR_RANK_WEIGHT * 100)}% rank +
          ${Math.round((1 - COMPETITOR_RANK_WEIGHT) * 100)}% distance</strong>,
          and the five highest are
          shown. Rank is weighted higher because competing is mostly about
          standing; distance breaks ties. Being ${RANK_SCALE} places apart, or
          ${DISTANCE_SCALE} km apart, halves that half of the score.
        </p>
      </details>` : ''}
  `;

  panel.classList.add('visible');
  panel.scrollTop = 0;

  panel.querySelector('.panel-close').addEventListener('click', () => {
    update(context, { selectedInstitution: null, selectedCountry: null });
    resetZoom(context);
  });

  const scoreInfo = panel.querySelector('.score-info');
  if (scoreInfo) {
    scoreInfo.addEventListener('click', () => {
      const explainer = panel.querySelector('.score-explainer');
      const opening = explainer.hasAttribute('hidden');
      explainer.toggleAttribute('hidden', !opening);
      scoreInfo.setAttribute('aria-expanded', String(opening));
    });
  }

  panel.querySelectorAll('.competitor-link').forEach(button => {
    button.addEventListener('click', () => {
      const target = data.institutions.find(i => i.id === button.dataset.institution);
      if (!target) return;
      update(context, {
        selectedInstitution: target.id,
        selectedCountry: target.country,
        selectedHub: null
      });
      zoomToPoint(context, [target.longitude, target.latitude], 8);
    });
  });
}

/** Distances span a few hundred metres to half the planet; round accordingly. */
function formatDistance(km) {
  if (km < 1) return '<1 km';
  if (km < 100) return `${Math.round(km)} km`;
  return `${Math.round(km / 100) * 100} km`;
}

/** Great-circle distance in kilometres. */
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function renderHubPanel(panel, context, state, data, hub, agg) {
  const points = hubPoints(hub, state, agg);
  const delta = hub.delta?.dlPointsGlobal;

  // Institutions are matched on the hub name carried by each institution
  // record, not on geography — a hub's membership is an editorial call.
  const institutions = agg.scored.filter(i => i.hub === hub.name);

  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="panel-eyebrow">Hub</p>
        <h2 class="panel-title">${escapeHtml(hub.name)}</h2>
        <p class="panel-subtitle">${escapeHtml(hub.country || '')}</p>
      </div>
      <button class="panel-close" type="button" aria-label="Close">×</button>
    </div>

    <table class="measure-table">
      <tr class="is-current">
        <td>${escapeHtml(MODULE_LABELS[state.selectedModule])} DL Points</td>
        <td class="value">${points === null ? '' : Math.round(points).toLocaleString()}</td>
      </tr>
      <tr>
        <td>Institutions</td>
        <td class="value">${hubInstitutionCount(hub, agg)}</td>
      </tr>
      ${delta !== undefined && delta !== null ? `
      <tr>
        <td>Change since DL25 (Overall)</td>
        <td class="value">${delta > 0 ? '+' : ''}${Math.round(delta).toLocaleString()}</td>
      </tr>` : ''}
    </table>

    ${institutionSection(institutions, state)}
  `;

  panel.classList.add('visible');
  panel.scrollTop = 0;

  panel.querySelector('.panel-close')
    .addEventListener('click', () => {
      update(context, { selectedHub: null });
      zoomToCountry(context, hub.country);
    });
}

/**
 * What the reader is looking at: the measure in plain words, then how much of
 * the ranking is on screen.
 *
 * The three counts are buttons. A figure like "41 countries" invites the
 * question "which ones?", and until now the interface had no answer: the only
 * way to find out was to hunt across the map. Each one opens the list it
 * counts, and every row in that list flies to the thing it names.
 *
 * Returns HTML. The institution count is of the scored set, which excludes the
 * rows the Next 50 brought in, so the total reads exactly as it did before the
 * tier existed. With the tier on, the institution view is showing the fifty and
 * says so.
 */
function scopeLine(state, data, agg) {
  const metric = metricMeta(state.colorMetric);

  const showingNext50 = state.view === 'institution' && state.showNext50
    && NEXT50_MODULES.includes(state.selectedModule);

  const places = agg.scored.length;
  const total = data.institutions.filter(i => !i.next50Only).length;
  const hubs = data.hubs.filter(h => agg.byHub.has(h.name)).length;

  const count = (kind, value, suffix, label) => `
    <li>
      <button class="key-count" type="button" data-browse="${kind}">
        <span class="key-count-value">${value}</span>
        <span class="key-count-label">${label}${suffix}</span>
        <span class="key-count-chevron" aria-hidden="true">&rsaquo;</span>
      </button>
    </li>`;

  return `
    <p class="key-measure">${escapeHtml(metric.description)}</p>
    <ul class="key-counts">
      ${count('institutions',
              places.toLocaleString(),
              agg.active ? ` of ${total.toLocaleString()}` : '',
              'universities &amp; schools')}
      ${count('countries', agg.byCountry.size, '', 'countries')}
      ${count('hubs', hubs, '', 'hubs')}
    </ul>
    <p class="key-edition">${escapeHtml(state.selectedEdition)}${
      agg.active ? ' &middot; filtered' : ''}${
      showingNext50 ? ' &middot; Next 50 shown' : ''}</p>`;
}


// ============================================================================
// PUBLIC API
// ============================================================================

window.DigitalLeadersMap = {
  init,
  render,
  update,
  resetZoom,
  zoomBy,
  buildModuleSelector,
  buildMetricSelector,
  buildFilters,
  buildSearch,
  showModulePanel,
  hideModulePanel,
  showNext50Panel,
  hideNext50Panel,
  explainControl,
  wireExplainers,
  exportDataset,
  buildExportSheets,
  openBrowse,
  closeBrowse,
  isBrowseOpen,
  wireBrowse,
  closePop,
  isPopOpen,
  openPop,
  CONTROL_EXPLAINERS,
  syncNext50Button,
  zoomToCountry,
  zoomToPoint,
  MODULE_LABELS,
  METRICS,
  getState: () => ({ ...STATE }),
  setState: (newState) => {
    STATE = { ...STATE, ...newState };
  },
  toAtlasName,
  COUNTRY_NAME_ALIASES,
  CITY_STATES_WITHOUT_GEOMETRY,
  CONFIG
};

console.log('[Map] Module loaded. Call window.DigitalLeadersMap.init(container) to start.');