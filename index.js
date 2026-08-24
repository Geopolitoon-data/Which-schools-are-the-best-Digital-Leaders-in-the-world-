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
  // Everything geographic goes inside `g` so it zooms and pans together;
  // the legend and caption hang off the static group so they stay put.
  const layers = {
    background: g.append('g').attr('class', 'layer-background'),
    graticule: g.append('g').attr('class', 'layer-graticule'),
    countries: g.append('g').attr('class', 'layer-countries'),
    cityStates: g.append('g').attr('class', 'layer-city-states'),
    hubs: g.append('g').attr('class', 'layer-hubs'),
    institutions: g.append('g').attr('class', 'layer-institutions'),
    interactive: g.append('g').attr('class', 'layer-interactive'),
    legend: gMargin.append('g').attr('class', 'layer-legend'),
    caption: gMargin.append('g').attr('class', 'layer-caption')
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

  drawLegend(layers.legend, STATE, data, values, colorScale, height, agg);
  drawCaption(layers.caption, STATE, data, width, height, agg);
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
    description: 'Total DL Points — one score for comparing countries directly, built from each institution’s position on the 1–150 ranking scale.'
  },
  {
    id: 'perCapita',
    label: 'Talent density',
    legend: 'DL Points per million people',
    description: 'DL Points against population. Surfaces small countries that rank far above their size.'
  },
  {
    id: 'delta',
    label: 'Evolution',
    legend: 'Change in DL Points, DL25 → DL26',
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

// Orange, from the brand palette. Global's own dots are navy, so the two tiers
// stay clearly apart on the one map.
const NEXT50_COLOR = '#FF4901';

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
  global: '#0F1374',      // navy
  AI: '#EFB41C',          // mustard, as Power – AI & Data on the DL site
  CS: '#B87308',          // ochre — a deeper shade of the Data and AI mustard,
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

// The elevated surface the explainer panels sit on, from tokens.css.
const PANEL_BACKGROUND = '#1D2154';

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
 * Lighten a colour just enough to be readable as text on `background`,
 * preserving its hue. A brand colour chosen to work as a fill is often far
 * too dark to double as type on a dark surface.
 */
function readableOn(colour, background, target = 4.5) {
  let result = colour;
  for (let step = 0; step <= 17 && contrast(result, background) < target; step += 1) {
    const amount = step * 0.05;
    result = '#' + [1, 3, 5].map(i => {
      const value = parseInt(colour.substr(i, 2), 16);
      return Math.round(value + (255 - value) * amount).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }
  return result;
}

/**
 * The explainer for a ranking, shown when its filter is clicked.
 * Closes on its own button, on Escape, or when another ranking is picked.
 */
function showModulePanel(module) {
  const panel = document.getElementById('module-panel');
  if (!panel) return;

  const description = MODULE_DESCRIPTIONS[module];
  if (!description) return hideModulePanel();

  // Title and frame carry the ranking's own colour, so the explainer is
  // visibly about the module you just clicked.
  //
  // The frame takes the colour as-is. The title cannot: Global's navy sits at
  // 1.02:1 on this panel and Entrepreneurship's violet at 2.56:1 — both
  // unreadable as text. Those are lightened until they clear 4.5:1, which
  // keeps the hue while making the word legible.
  const colour = MODULE_COLORS[module] || MODULE_COLORS.global;
  const title = panel.querySelector('#module-panel-title');
  title.textContent = MODULE_LABELS[module] || module;
  title.style.color = readableOn(colour, PANEL_BACKGROUND);
  panel.style.borderColor = colour;
  panel.querySelector('#module-panel-body').textContent = description;
  panel.removeAttribute('hidden');
}

function hideModulePanel() {
  const panel = document.getElementById('module-panel');
  if (panel) panel.setAttribute('hidden', '');
}

function showNext50Panel() {
  hideModulePanel();
  const panel = document.getElementById('next50-panel');
  if (panel) panel.removeAttribute('hidden');
}

function hideNext50Panel() {
  const panel = document.getElementById('next50-panel');
  if (panel) panel.setAttribute('hidden', '');
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
    button.className = 'module-button';
    button.dataset.module = module;
    button.textContent = MODULE_LABELS[module] || module;
    button.setAttribute('aria-pressed', String(module === STATE.selectedModule));

    // Clicking a ranking both selects it and explains what it covers —
    // clicking the one already selected just re-opens the explanation.
    button.addEventListener('click', () => {
      if (STATE.selectedModule !== module) {
        update(context, { selectedModule: module });
      }
      showModulePanel(module);
    });

    mount.appendChild(button);
  });

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
      <button class="filter-trigger" type="button" data-menu="types">
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

    <select id="rank-filter" class="metric-selector">
      ${RANK_OPTIONS.map(o => `<option value="${o.id}">${o.label}</option>`).join('')}
    </select>

    <button id="clear-filters" class="help-button" type="button" hidden>Clear filters</button>
  `;

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

  const description = document.querySelector('#metric-description');
  if (description) {
    description.textContent = metricMeta(STATE.colorMetric).description;
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
function hoverFigures(entity, kind, totals, state, data, agg) {
  const module = MODULE_LABELS[state.selectedModule];
  const standing = standingOn(entity, kind, state, data, agg);
  const peers = kind === 'hub' ? 'hubs' : 'countries';

  const value = kind === 'hub'
    ? hubPoints(entity, state, agg)
    : countryMetricValue(entity, state, agg);

  const headline = {
    dlPoints: {
      figure: value === null ? '—' : Math.round(value).toLocaleString(),
      label: `DL Points in ${module}`
    },
    perCapita: {
      figure: value === null ? '—' : value.toFixed(1),
      label: `DL Points per million people, ${module}`
    },
    delta: {
      figure: value === null ? '—' : (value > 0 ? '+' : '') + Math.round(value).toLocaleString(),
      label: `DL Points gained or lost, DL25 → DL26, ${module}`
    }
  }[state.colorMetric] || {
    figure: value === null ? '—' : Math.round(value).toLocaleString(),
    label: `DL Points in ${module}`
  };

  return `
    <div class="hover-figures">
      <div class="hover-figure">
        <span class="hover-points-value${state.colorMetric === 'delta'
          ? (value > 0 ? ' is-up' : value < 0 ? ' is-down' : '') : ''}">${headline.figure}</span>
        <span class="hover-points-label">${escapeHtml(headline.label)}</span>
      </div>
      <div class="hover-figure">
        <span class="hover-points-value">${standing ? '#' + standing.rank : '—'}</span>
        <span class="hover-points-label">${standing
          ? `of ${standing.of} ${peers} · ${escapeHtml(metricMeta(state.colorMetric).label)}`
          : 'not ranked here'}</span>
      </div>
    </div>`;
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

  return `
    <div class="hover-head">
      <span class="hover-title">${escapeHtml(entity.name)}</span>
      ${subtitle ? `<span class="hover-sub">${escapeHtml(subtitle)}</span>` : ''}
    </div>
    ${hoverFigures(entity, kind, totals, state, data, agg)}
    <p class="hover-scope">${escapeHtml(MODULE_LABELS[selected])} ranking</p>
    <table class="hover-table">
      <caption>Ranked institutions, across all rankings</caption>
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

function drawLegend(selection, state, data, values, colorScale, height, agg) {
  selection.selectAll('*').remove();

  // The institution view has no choropleth to explain; the key that matters
  // is which ranking the dots represent.
  if (state.view === 'institution') {
    // Sits lower than the country legend because it is a two-line key rather
    // than a gradient bar with ticks — anchored so its baseline clears the
    // caption by about the same margin the country legend does.
    selection.attr('transform', `translate(24, ${height - 82})`);

    selection.append('text')
      .attr('class', 'legend-heading')
      .attr('y', -10)
      .text('Institutions ranked in');

    const showingNext50 = state.showNext50
      && NEXT50_MODULES.includes(state.selectedModule);

    const key = (y, fill, label) => {
      const row = selection.append('g').attr('transform', `translate(0, ${y})`);
      row.append('circle')
        .attr('cx', 6).attr('cy', 6).attr('r', 6)
        .attr('fill', fill)
        .attr('stroke', '#FFFFFF')
        .attr('stroke-width', 1);
      row.append('text')
        .attr('class', 'legend-tick')
        .attr('x', 20).attr('y', 10)
        .text(label);
    };

    key(2, MODULE_COLORS[state.selectedModule],
        MODULE_LABELS[state.selectedModule]
          + (showingNext50 ? ' · top 150' : ''));

    if (showingNext50) {
      key(22, NEXT50_COLOR, 'Next 50 · ranks 151–200');
    }

    return;
  }

  if (!values.length) return;

  const barWidth = 180;
  const barHeight = 10;
  // Leaves room for both key rows and the caption below.
  selection.attr('transform', `translate(24, ${height - 116})`);

  const { lo, hi, clamped } = metricBounds(state.colorMetric, values);
  const bounds = [lo, hi];

  // Sample the scale into a gradient so the legend can't drift from the map.
  const gradient = selection.append('defs')
    .append('linearGradient')
    .attr('id', 'legend-gradient')
    .attr('x1', '0%')
    .attr('x2', '100%');

  const steps = 16;
  d3.range(steps + 1).forEach(i => {
    const t = i / steps;
    gradient.append('stop')
      .attr('offset', `${t * 100}%`)
      .attr('stop-color', colorScale(bounds[0] + t * (bounds[1] - bounds[0])));
  });

  selection.append('text')
    .attr('class', 'legend-heading')
    .attr('y', -10)
    .text(`${MODULE_LABELS[state.selectedModule]} · ${metricMeta(state.colorMetric).legend}`);

  selection.append('rect')
    .attr('width', barWidth)
    .attr('height', barHeight)
    .attr('rx', 2)
    .attr('fill', 'url(#legend-gradient)');

  // A leading ≤ / ≥ tells the reader the ends of the ramp are saturated
  // rather than being the true extremes of the data.
  const lowLabel = (clamped ? '≤ ' : '') + scales.formatDataValue(bounds[0], state.colorMetric);
  const highLabel = (clamped ? '≥ ' : '') + scales.formatDataValue(bounds[1], state.colorMetric);

  selection.append('text')
    .attr('class', 'legend-tick')
    .attr('y', barHeight + 14)
    .text(lowLabel);

  selection.append('text')
    .attr('class', 'legend-tick')
    .attr('x', barWidth)
    .attr('text-anchor', 'end')
    .attr('y', barHeight + 14)
    .text(highLabel);

  const keyRow = (y, swatchClass, label) => {
    const row = selection.append('g').attr('transform', `translate(0, ${y})`);
    row.append('rect')
      .attr('class', swatchClass)
      .attr('width', 10)
      .attr('height', 10)
      .attr('rx', 2);
    row.append('text')
      .attr('class', 'legend-tick')
      .attr('x', 16)
      .attr('y', 9)
      .text(label);
  };

  keyRow(barHeight + 26, 'legend-swatch-unranked', 'Not ranked');

  // Only advertise a "no figures" key when some ranked country actually
  // lacks a value for the metric on screen.
  const missing = data.countries
    .filter(c => agg.byCountry.has(c.name) && !hasMetricValue(c, state, agg)).length;
  if (missing > 0) {
    keyRow(barHeight + 44, 'legend-swatch-nodata', `No figures available (${missing})`);
  }
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
        <td class="value">${known ? escapeHtml(scales.formatDataValue(value, metric.id)) : '—'}</td>
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
            <span class="hub-link-meta">${count} institution${count === 1 ? '' : 's'} · ${Math.round(hubPoints(h, state, agg) || 0).toLocaleString()} pts</span>
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

  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">${escapeHtml(country.name)}</h2>
        <p class="panel-subtitle">${escapeHtml(formatRegion(country.region))}</p>
      </div>
      <button class="panel-close" type="button" aria-label="Close">×</button>
    </div>

    ${enrichment ? `<p class="panel-enrichment">${escapeHtml(enrichment)}</p>` : ''}

    <h3 class="panel-section">${escapeHtml(moduleLabel)} · how it measures up</h3>
    <table class="measure-table">${measureRows}</table>

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
        <span class="institution-rank">${rank === null ? '—' : rank}</span>
        <span class="institution-body">
          <span class="institution-name">${escapeHtml(institution.name)}</span>
          <span class="institution-type">${escapeHtml(typeLabel(institution.type) || '')}</span>
        </span>
      </li>`;
  };

  return `
    <h3 class="panel-section">
      Institutions in ${escapeHtml(MODULE_LABELS[state.selectedModule])}
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
  const change = totals ? totals.DL26 - totals.DL25 : 0;
  const movement = `
    <h3 class="panel-section">Movement since DL25</h3>
    <p class="panel-note big-number ${change > 0 ? 'is-up' : change < 0 ? 'is-down' : ''}">
      ${change > 0 ? '+' : ''}${Math.round(change).toLocaleString()} points
    </p>
    <p class="panel-note">
      ${escapeHtml(MODULE_LABELS[state.selectedModule])} DL Points, DL25 → DL26.
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
            from where an institution sits on that 1&ndash;150 scale — the higher the
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
          — <strong>${escapeHtml(typeLabel(institution.type))}</strong> —
          within <strong>${escapeHtml(group.label)}</strong>. An institution is
          compared inside its own region, except in India, Japan and Israel,
          which each form a group of their own.
        </p>
        <p>
          Within that group, a competitor is close on <strong>both</strong>
          counts: near in the ${escapeHtml(MODULE_LABELS[module])} ranking, and
          near geographically. Each gets two closeness scores between 0 and 1 —
        </p>
        <p class="method-formula">
          rank closeness = 1 ÷ (1 + places apart ÷ ${RANK_SCALE})<br>
          distance closeness = 1 ÷ (1 + km apart ÷ ${DISTANCE_SCALE})
        </p>
        <p>
          — which are combined as
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
        <td class="value">${points === null ? '—' : Math.round(points).toLocaleString()}</td>
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

function drawCaption(selection, state, data, width, height, agg) {
  selection.selectAll('*').remove();
  selection.attr('transform', `translate(24, ${height - 28})`);

  // The caption counts what is actually on screen. In the country view that is
  // the scored set, which excludes the rows the Next 50 brought in — so the
  // total reads exactly as it did before the tier existed. With the tier on,
  // the institution view is showing the fifty and says so.
  const showingNext50 = state.view === 'institution' && state.showNext50
    && NEXT50_MODULES.includes(state.selectedModule);

  const institutions = agg.scored.length;
  const total = data.institutions.filter(i => !i.next50Only).length;
  const countries = agg.byCountry.size;
  const scope = (agg.active
    ? `${institutions} of ${total} institutions · ${countries} countries · filtered`
    : `${institutions} institutions · ${countries} countries · ${state.selectedEdition}`)
    + (showingNext50 ? ' · Next 50 shown' : '');

  selection.append('text')
    .attr('class', `caption${agg.active ? ' is-filtered' : ''}`)
    .text(scope);
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