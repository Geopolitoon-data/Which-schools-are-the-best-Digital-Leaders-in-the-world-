/**
 * D3 SCALES & COLOR FUNCTIONS
 * Defines all scale functions for the visualization
 */

const scales = (() => {
  // ========================================================================
  // COLOR SCALES
  // ========================================================================

  // ------------------------------------------------------------------------
  // Country fills use the Emerging palette and nothing else:
  //   navy #0F1374 · periwinkle #4B5BCB · orange #FF4901
  //   salmon #FF9E79 · gold #DBB67D · maroon #860018
  //
  // The ramp climbs navy → periwinkle → orange → salmon, so intensity rises
  // with the value and the busiest countries read as the most luminous.
  // ------------------------------------------------------------------------
  const COUNTRY_RAMP = ['#0F1374', '#4B5BCB', '#FF4901', '#FF9E79'];

  const dlPointsSequential = (maxValue) => {
    return d3.scaleLinear()
      .domain([0, maxValue * 0.33, maxValue * 0.7, maxValue])
      .range(COUNTRY_RAMP)
      .clamp(true);
  };

  // DL Points, square-root compressed.
  //
  // DL Points are extremely top-heavy — the USA sits near 3500 while the
  // median country is under 200. On a linear ramp almost every country
  // renders as flat navy and the map says nothing. Compressing the domain
  // with a 0.5 exponent spreads the mid-field out so the difference between,
  // say, Singapore and Sweden is actually visible.
  const dlPointsScale = (maxValue) => {
    return d3.scalePow()
      .exponent(0.5)
      .domain([0, maxValue * 0.33, maxValue * 0.7, maxValue])
      .range(COUNTRY_RAMP)
      .clamp(true);
  };

  // Evolution diverging: red falling ← neutral → green rising.
  //
  // Direction has to be readable without consulting a legend, so this is the
  // one place the palette gives way to the universal red/green convention.
  // The green is desaturated toward the brand's depth rather than a signal
  // green, so it still sits with navy and maroon.
  const editionDelta = (range) => {
    const absMax = Math.max(Math.abs(range[0]), Math.abs(range[1])) || 1;
    return d3.scaleDiverging()
      .domain([-absMax, 0, absMax])
      .range(['#C21E2F', '#F2F0F4', '#0E8A5F'])
      .clamp(true);
  };

  // Per-capita strength: the same ramp, minus the darkest stop, so small
  // high-density countries stay legible instead of sinking into the ground.
  const perCapitaStrength = (maxValue) => {
    return d3.scaleLinear()
      .domain([0, maxValue * 0.5, maxValue])
      .range(['#4B5BCB', '#FF4901', '#FF9E79'])
      .clamp(true);
  };

  // One colour per ranking, matching MODULE_COLORS in index.js. Keep the two
  // in step: green is Digital Transformation, mauve is Entrepreneurship.
  const moduleColor = d3.scaleOrdinal()
    .domain(['global', 'AI', 'CS', 'transform', 'create'])
    .range(['#0F1374', '#EFB41C', '#B87308', '#93B23C', '#9B1FD8']);

  // Categorical: 5 Emerging brand colors
  const categorical = d3.scaleOrdinal()
    .domain(['AI', 'CS', 'Transform', 'Create', 'Global'])
    .range(['#4B5BCB', '#FF4901', '#DBB67D', '#FF9E79', '#0F1374']);

  // ========================================================================
  // SIZE SCALES
  // ========================================================================

  // Bubble size: 2px to 20px radius
  const bubbleSize = (maxValue) => {
    return d3.scaleSqrt()
      .domain([0, maxValue])
      .range([2, 20])
      .clamp(true);
  };

  // Stroke width: 0.5px to 3px
  const strokeWidth = (maxValue) => {
    return d3.scaleLinear()
      .domain([0, maxValue])
      .range([0.5, 3])
      .clamp(true);
  };

  // ========================================================================
  // OPACITY/INTERACTION SCALES
  // ========================================================================

  // Interaction opacity: dim to full
  const interactionOpacity = d3.scaleLinear()
    .domain([0, 1])
    .range([0.2, 1]);

  // ========================================================================
  // UTILITY FUNCTIONS
  // ========================================================================

  // Get appropriate scale for a metric
  const getScaleForMetric = (metric, maxValue, range) => {
    const scaleMap = {
      dlPoints: dlPointsScale(maxValue),
      perCapita: perCapitaStrength(maxValue),
      delta: editionDelta(range || [-50, 50]),
      top50Count: d3.scaleLinear().domain([0, 5]).range(['#0F1374', '#FF9E79']),
      breadth: d3.scaleLinear().domain([0, 5]).range(['#0F1374', '#DBB67D']),
      concentration: d3.scaleLinear().domain([0, 100]).range(['#0F1374', '#FF4901'])
    };
    return scaleMap[metric] || dlPointsSequential(maxValue);
  };

  // Get scale bounds (min, max, midpoint)
  const getScaleBounds = (data, metric) => {
    const values = data.map(d => d[metric]).filter(v => v !== null && v !== undefined);
    if (values.length === 0) return { min: 0, max: 0, mid: 0 };
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max, mid: (min + max) / 2 };
  };

  // Format data value for display
  const formatDataValue = (value, metric) => {
    if (value === null || value === undefined) return '—';

    const formatters = {
      dlPoints: (v) => Math.round(v).toLocaleString(),
      perCapita: (v) => v.toFixed(1),
      perGdp: (v) => Math.round(v).toLocaleString(),
      perNri: (v) => v.toFixed(2),
      delta: (v) => (v > 0 ? '+' : '') + v.toFixed(0),
      rank: (v) => Math.round(v).toString(),
      percentage: (v) => (v * 100).toFixed(1) + '%',
      count: (v) => Math.round(v).toString()
    };

    const formatter = formatters[metric] || (v => v.toString());
    return formatter(value);
  };

  // Read CSS variable (for dynamic color updates)
  const getCSSVar = (varName) => {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  };

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  return {
    dlPointsSequential,
    dlPointsScale,
    editionDelta,
    perCapitaStrength,
    moduleColor,
    categorical,
    bubbleSize,
    strokeWidth,
    interactionOpacity,
    getScaleForMetric,
    getScaleBounds,
    formatDataValue,
    getCSSVar
  };
})();

console.log('[Scales] Module loaded');