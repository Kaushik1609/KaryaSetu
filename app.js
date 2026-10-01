// ==========================================================================
// KaryaSetu — Forecast Reliability Dashboard Logic
// Scientific Prototype: WeatherBench 2 HRES Grid & Calibrated XGBoost
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  
  // State Variables
  let currentRegion = 'Maharashtra';
  let currentLeadDay = 5; // 1 to 10
  let mapMode = 'confidence'; // 'confidence' or 'bust'
  let showWind = true;
  let showGrid = true;

  // Chart Instances
  let trendChartInstance = null;
  let modalChartInstance = null;

  // Map & Layers
  let map = null;
  let gridLayerGroup = null;
  let stateLayerGroup = null;
  let windCanvas = null;
  let windCtx = null;
  let animationFrameId = null;

  // DOM Elements - User Controls
  const selectRegion = document.getElementById('selectRegion');
  const selectLeadTime = document.getElementById('selectLeadTime');
  const inputDate = document.getElementById('inputDate');

  // DOM Elements - KPI Panel
  const lblSelectedRegion = document.getElementById('lblSelectedRegion');
  const lblLeadBadge = document.getElementById('lblLeadBadge');
  const valConfidence = document.getElementById('valConfidence');
  const valBustProb = document.getElementById('valBustProb');
  const lblRiskCategory = document.getElementById('lblRiskCategory');

  // DOM Elements - Forecast Details
  const detPrecip = document.getElementById('detPrecip');
  const detTemp = document.getElementById('detTemp');
  const detPress = document.getElementById('detPress');
  const detHumidity = document.getElementById('detHumidity');
  const detVelocity = document.getElementById('detVelocity');

  // DOM Elements - SHAP Panel
  const shapBarsList = document.getElementById('shapBarsList');

  // DOM Elements - Map Controls
  const btnModeConfidence = document.getElementById('btnModeConfidence');
  const btnModeBustProb = document.getElementById('btnModeBustProb');
  const btnToggleWind = document.getElementById('btnToggleWind');
  const btnToggleGrid = document.getElementById('btnToggleGrid');
  const btnResetMap = document.getElementById('btnResetMap');

  // DOM Elements - Modals & Buttons
  const btnFullExplanation = document.getElementById('btnFullExplanation');
  const modalExplanation = document.getElementById('modalExplanation');
  const btnCloseExplanation = document.getElementById('btnCloseExplanation');
  const btnCloseExplanationFooter = document.getElementById('btnCloseExplanationFooter');

  const btnFullTimeSeries = document.getElementById('btnFullTimeSeries');
  const modalTimeSeries = document.getElementById('modalTimeSeries');
  const btnCloseTimeSeries = document.getElementById('btnCloseTimeSeries');

  // --------------------------------------------------------------------------
  // 1. Initialize Leaflet Satellite & Grid Map
  // --------------------------------------------------------------------------
  function initMap() {
    // Center map on India (Lat: 21.5°N, Lon: 79.5°E, Zoom Level: 5)
    map = L.map('map', {
      zoomControl: false,
      attributionControl: false
    }).setView([21.5, 79.5], 5);

    // Add Zoom Control at bottom right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Satellite Imagery Basemap (Esri World Imagery)
    const satelliteBasemap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 13,
      minZoom: 4
    });

    // Dark Reference Labels Overlay
    const labelOverlay = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{y}/{x}{r}.png', {
      maxZoom: 13,
      subdomains: 'abcd'
    });

    satelliteBasemap.addTo(map);
    labelOverlay.addTo(map);

    gridLayerGroup = L.layerGroup().addTo(map);
    stateLayerGroup = L.layerGroup().addTo(map);

    // Draw Vector State Boundaries
    drawStateBoundaries();

    // Render Grid Cells Overlay
    renderGridOverlay();

    // Setup Wind Particle Canvas Layer
    setupWindCanvas();

    // Redraw map visuals on view reset/move
    map.on('moveend resize zoomend', () => {
      resetWindParticles();
    });
  }

  // --------------------------------------------------------------------------
  // 2. Draw Vector State Polygons (Vector Boundaries)
  // --------------------------------------------------------------------------
  function drawStateBoundaries() {
    stateLayerGroup.clearLayers();

    if (typeof INDIA_STATE_PATHS !== 'undefined') {
      for (const [stateName, pathSvg] of Object.entries(INDIA_STATE_PATHS)) {
        if (!pathSvg) continue;
      }
    }

    // Fallback GeoJSON boundary rendering if available
    if (typeof INDIA_GEOJSON !== 'undefined') {
      L.geoJSON(INDIA_GEOJSON, {
        style: function(feature) {
          const isSelected = feature.properties && feature.properties.ST_NM === currentRegion;
          return {
            color: isSelected ? '#f97316' : 'rgba(255, 255, 255, 0.4)',
            weight: isSelected ? 2.5 : 1,
            fillColor: 'transparent',
            fillOpacity: 0
          };
        },
        onEachFeature: function(feature, layer) {
          layer.on('click', function() {
            if (feature.properties && feature.properties.ST_NM) {
              selectRegionByName(feature.properties.ST_NM);
            }
          });
        }
      }).addTo(stateLayerGroup);
    }
  }

  // --------------------------------------------------------------------------
  // 3. Render Native Grid Cells (~5.625° Coarse Grid Resolution)
  // --------------------------------------------------------------------------
  function renderGridOverlay() {
    gridLayerGroup.clearLayers();
    if (!showGrid) return;

    const dayKey = `Day_${currentLeadDay}`;
    const dayData = SIMULATION_DATA[dayKey];
    if (!dayData) return;

    GRID_COORDINATES.forEach((coord, idx) => {
      // Find matching state data or default metrics
      const stateName = findClosestState(coord.lat, coord.lon);
      const stateInfo = dayData.states[stateName] || dayData.states['Maharashtra'];
      
      const conf = stateInfo.confidence;
      const bust = stateInfo.bust_probability;
      
      let color = '#10b981'; // Green (High Confidence)
      if (conf < 40) color = '#ef4444'; // Red (Low Confidence / High Bust)
      else if (conf < 70) color = '#f59e0b'; // Yellow (Moderate)

      // Calculate grid cell bounding box (~2.8° radius around centroid)
      const latHalf = 2.8125;
      const lonHalf = 2.8125;
      const bounds = [
        [coord.lat - latHalf, coord.lon - lonHalf],
        [coord.lat + latHalf, coord.lon + lonHalf]
      ];

      // Semi-transparent grid cell rectangle over satellite map
      const rect = L.rectangle(bounds, {
        color: color,
        weight: 1.2,
        fillColor: color,
        fillOpacity: mapMode === 'confidence' ? 0.35 : 0.45
      });

      // Grid Cell Click Popup Interaction
      const popupHtml = `
        <div class="popup-grid-title">${stateName}</div>
        <div class="popup-row">
          <span class="popup-lbl">Forecast Horizon:</span>
          <span class="popup-val">Day ${currentLeadDay} / ${currentLeadDay * 24}h</span>
        </div>
        <div class="popup-row">
          <span class="popup-lbl">P(BUST):</span>
          <span class="popup-val" style="color: ${bust > 60 ? '#ef4444' : '#f59e0b'};">${bust.toFixed(1)}%</span>
        </div>
        <div class="popup-row">
          <span class="popup-lbl">Forecast Confidence:</span>
          <span class="popup-val" style="color: ${conf > 70 ? '#10b981' : (conf > 40 ? '#f59e0b' : '#ef4444')};">${conf.toFixed(1)}%</span>
        </div>
        <div class="popup-row">
          <span class="popup-lbl">Risk:</span>
          <span class="popup-val" style="text-transform: uppercase;">${stateInfo.category}</span>
        </div>
        <button class="btn-popup-explain" onclick="window.selectGridRegion('${stateName}')">View Explanation</button>
      `;

      rect.bindPopup(popupHtml);
      rect.addTo(gridLayerGroup);
    });
  }

  // Helper: Map grid lat/lon to state name
  function findClosestState(lat, lon) {
    if (lat > 28) return 'Uttarakhand';
    if (lat > 24 && lon < 76) return 'Rajasthan';
    if (lat > 24 && lon < 82) return 'Madhya Pradesh';
    if (lat > 24 && lon >= 88) return 'Assam';
    if (lat > 20 && lon < 76) return 'Gujarat';
    if (lat > 18 && lon < 78) return 'Maharashtra';
    if (lat > 18 && lon >= 82) return 'Odisha';
    if (lat > 14 && lon < 78) return 'Karnataka';
    if (lat > 14 && lon >= 78) return 'Andhra Pradesh';
    if (lat <= 14 && lon < 77) return 'Kerala';
    return 'Tamil Nadu';
  }

  // Global window handler for popup explanation click
  window.selectGridRegion = function(stateName) {
    selectRegionByName(stateName);
    // Scroll to SHAP panel on right column
    const shapPanel = document.getElementById('shapPanel');
    if (shapPanel) {
      shapPanel.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // --------------------------------------------------------------------------
  // 4. Subtle Wind Particle Overlay Canvas
  // --------------------------------------------------------------------------
  let particles = [];
  const PARTICLE_COUNT = 60;

  function setupWindCanvas() {
    windCanvas = document.getElementById('windCanvas');
    if (!windCanvas) return;

    resizeWindCanvas();
    window.addEventListener('resize', resizeWindCanvas);

    resetWindParticles();
    animateWind();
  }

  function resizeWindCanvas() {
    if (!windCanvas) return;
    const mapDiv = document.getElementById('map');
    windCanvas.width = mapDiv.clientWidth;
    windCanvas.height = mapDiv.clientHeight;
  }

  function resetWindParticles() {
    particles = [];
    if (!windCanvas) return;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * windCanvas.width,
        y: Math.random() * windCanvas.height,
        vx: 0.8 + Math.random() * 1.2, // Southerly/Westerly monsoon flow
        vy: -0.4 - Math.random() * 0.6,
        life: Math.random() * 80,
        maxLife: 60 + Math.random() * 40
      });
    }
  }

  function animateWind() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    if (showWind && windCanvas && windCanvas.getContext) {
      windCtx = windCanvas.getContext('2d');
      windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);

      windCtx.strokeStyle = 'rgba(14, 165, 233, 0.45)'; // Subtle teal particle stream
      windCtx.lineWidth = 1.2;

      particles.forEach(p => {
        windCtx.beginPath();
        windCtx.moveTo(p.x, p.y);
        p.x += p.vx;
        p.y += p.vy;
        p.life++;

        windCtx.lineTo(p.x, p.y);
        windCtx.stroke();

        if (p.x > windCanvas.width || p.y < 0 || p.life > p.maxLife) {
          p.x = Math.random() * windCanvas.width * 0.8;
          p.y = windCanvas.height * 0.5 + Math.random() * (windCanvas.height * 0.5);
          p.life = 0;
        }
      });
    } else if (windCanvas && windCanvas.getContext) {
      windCtx = windCanvas.getContext('2d');
      windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
    }

    animationFrameId = requestAnimationFrame(animateWind);
  }

  // --------------------------------------------------------------------------
  // 5. Update All Right Column Metrics & Dashboard State
  // --------------------------------------------------------------------------
  function updateDashboard() {
    const dayKey = `Day_${currentLeadDay}`;
    const dayData = SIMULATION_DATA[dayKey];
    if (!dayData) return;

    const stateInfo = dayData.states[currentRegion] || dayData.states['Maharashtra'];
    const leadHours = currentLeadDay * 24;

    // Header Labels
    lblSelectedRegion.innerText = `Selected region: ${currentRegion}`;
    lblLeadBadge.innerText = `Day ${currentLeadDay} / ${leadHours}h`;

    // Large Numeric Indicators
    const conf = stateInfo.confidence;
    const bust = stateInfo.bust_probability;

    valConfidence.innerText = `${conf.toFixed(0)}%`;
    valBustProb.innerText = `${bust.toFixed(0)}%`;

    // Set Color Coding
    if (conf >= 70) {
      valConfidence.className = 'kpi-num green-text';
      valBustProb.className = 'kpi-num yellow-text';
    } else if (conf >= 40) {
      valConfidence.className = 'kpi-num yellow-text';
      valBustProb.className = 'kpi-num yellow-text';
    } else {
      valConfidence.className = 'kpi-num red-text';
      valBustProb.className = 'kpi-num red-text';
    }

    // Risk Category Badge
    const cat = stateInfo.category.toLowerCase();
    lblRiskCategory.innerText = stateInfo.category.toUpperCase();
    if (cat === 'low' || cat === 'high confidence') {
      lblRiskCategory.className = 'risk-badge badge-low';
    } else if (cat === 'high' || cat === 'high bust alert') {
      lblRiskCategory.className = 'risk-badge badge-high';
    } else {
      lblRiskCategory.className = 'risk-badge badge-moderate';
    }

    // Forecast Details Mini-Card
    detPrecip.innerText = `${stateInfo.expected_rain_mm.toFixed(1)} mm`;
    detTemp.innerText = `${stateInfo.temperature_c.toFixed(1)} °C`;
    detPress.innerText = `${stateInfo.pressure_hpa.toFixed(0)} hPa`;
    detHumidity.innerText = `${stateInfo.humidity_pct || 78}%`;

    // Extract 500hPa Vertical Velocity from SHAP breakdown
    const vvItem = stateInfo.shap_breakdown.find(s => s.feature.includes('Vertical Velocity'));
    detVelocity.innerText = vvItem ? `${vvItem.value.toFixed(2)} Pa/s` : '0.04 Pa/s';

    // Update Time Series Chart
    renderTrendChart();

    // Render TOP 4 SHAP Feature Contributions Card
    renderTop4ShapBars(stateInfo.shap_breakdown);

    // Refresh Map Layers
    drawStateBoundaries();
    renderGridOverlay();
  }

  // --------------------------------------------------------------------------
  // 6. TOP 4 SHAP Feature Contributions Card Render
  // --------------------------------------------------------------------------
  function renderTop4ShapBars(shapList) {
    shapBarsList.innerHTML = '';
    if (!shapList || shapList.length === 0) return;

    // Feature formatting map for clean meteorological terms
    const formatMap = {
      'Vertical Velocity (500 hPa)': '500-hPa Vertical Velocity',
      'vertical_velocity_500': '500-hPa Vertical Velocity',
      'Total 24h Precipitation': 'Total Precipitation',
      'total_precipitation_24hr': 'Total Precipitation',
      'Lead Time Decay': 'Lead Time',
      'lead_hours': 'Lead Time',
      'MSL Pressure Gradient': 'MSL Pressure',
      'mean_sea_level_pressure': 'MSL Pressure',
      'Specific Humidity (850 hPa)': '850-hPa Humidity',
      '2m Air Temperature': '2m Temperature',
      '10m Wind Shear': '10m Wind Component'
    };

    // Pick top 4 features by contribution magnitude
    const top4 = shapList.slice(0, 4);
    const maxVal = Math.max(...top4.map(s => Math.abs(s.value)), 0.1);

    top4.forEach(item => {
      const formattedName = formatMap[item.feature] || item.feature;
      const pct = Math.min(100, Math.round((Math.abs(item.value) / maxVal) * 100));
      const isPositive = item.direction === 'positive' || item.value > 0;

      const div = document.createElement('div');
      div.className = 'shap-item';
      div.innerHTML = `
        <div class="shap-item-header">
          <span class="shap-name">${formattedName}</span>
          <span class="shap-val" style="color: ${isPositive ? '#ef4444' : '#0ea5e9'};">
            ${isPositive ? '+' : ''}${item.value.toFixed(3)}
          </span>
        </div>
        <div class="shap-track">
          <div class="shap-bar ${isPositive ? 'pos' : 'neutral'}" style="width: ${pct}%;"></div>
        </div>
      `;
      shapBarsList.appendChild(div);
    });
  }

  // --------------------------------------------------------------------------
  // 7. Render Small Time Series Line Chart (Day 1 -> Day 10)
  // --------------------------------------------------------------------------
  function renderTrendChart() {
    const ctx = document.getElementById('trendChart');
    if (!ctx) return;

    // Extract 10-day timeline trend for current region
    const labels = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'];
    const confData = [];
    const bustData = [];

    for (let day = 1; day <= 10; day++) {
      const dKey = `Day_${day}`;
      const dInfo = SIMULATION_DATA[dKey]?.states[currentRegion];
      if (dInfo) {
        confData.push(dInfo.confidence);
        bustData.push(dInfo.bust_probability);
      } else {
        confData.push(70 - day * 4);
        bustData.push(30 + day * 4);
      }
    }

    if (trendChartInstance) {
      trendChartInstance.destroy();
    }

    trendChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Forecast Confidence',
            data: confData,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            borderWidth: 2,
            pointRadius: 2.5,
            tension: 0.35,
            fill: true
          },
          {
            label: 'P(BUST)',
            data: bustData,
            borderColor: '#f59e0b',
            borderDash: [4, 4],
            borderWidth: 1.8,
            pointRadius: 2,
            tension: 0.35,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: function(context) {
                return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}%`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 10, family: 'Inter' } }
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: 'rgba(226, 232, 240, 0.6)' },
            ticks: { font: { size: 10, family: 'Inter' }, stepSize: 50 }
          }
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // 8. Region & User Control Event Handlers
  // --------------------------------------------------------------------------
  function selectRegionByName(regionName) {
    currentRegion = regionName;
    selectRegion.value = regionName;
    updateDashboard();
  }

  selectRegion.addEventListener('change', (e) => {
    currentRegion = e.target.value;
    updateDashboard();
  });

  selectLeadTime.addEventListener('change', (e) => {
    currentLeadDay = parseInt(e.target.value, 10);
    updateDashboard();
  });

  // Floating Map Controls
  btnModeConfidence.addEventListener('click', () => {
    mapMode = 'confidence';
    btnModeConfidence.classList.add('active');
    btnModeBustProb.classList.remove('active');
    renderGridOverlay();
  });

  btnModeBustProb.addEventListener('click', () => {
    mapMode = 'bust';
    btnModeBustProb.classList.add('active');
    btnModeConfidence.classList.remove('active');
    renderGridOverlay();
  });

  btnToggleWind.addEventListener('click', () => {
    showWind = !showWind;
    btnToggleWind.classList.toggle('active', showWind);
    resetWindParticles();
  });

  btnToggleGrid.addEventListener('click', () => {
    showGrid = !showGrid;
    btnToggleGrid.classList.toggle('active', showGrid);
    renderGridOverlay();
  });

  btnResetMap.addEventListener('click', () => {
    map.setView([21.5, 79.5], 5);
    selectRegionByName('Maharashtra');
    selectLeadTime.value = '5';
    currentLeadDay = 5;
    updateDashboard();
  });

  // --------------------------------------------------------------------------
  // 9. Modals Logic (Full Explanation & Full Time Series)
  // --------------------------------------------------------------------------
  btnFullExplanation.addEventListener('click', () => {
    const dayKey = `Day_${currentLeadDay}`;
    const stateInfo = SIMULATION_DATA[dayKey]?.states[currentRegion];
    if (!stateInfo) return;

    document.getElementById('modalRegionName').innerText = currentRegion;
    document.getElementById('modalLeadDay').innerText = currentLeadDay;

    const container = document.getElementById('modalShapContainer');
    container.innerHTML = '';

    stateInfo.shap_breakdown.forEach(item => {
      const row = document.createElement('div');
      row.className = 'shap-item';
      const isPos = item.direction === 'positive' || item.value > 0;
      row.innerHTML = `
        <div class="shap-item-header">
          <span class="shap-name">${item.feature}</span>
          <span class="shap-val" style="color: ${isPos ? '#ef4444' : '#0ea5e9'};">
            ${isPos ? '+' : ''}${item.value.toFixed(3)} ${item.unit || ''}
          </span>
        </div>
        <div class="shap-track">
          <div class="shap-bar ${isPos ? 'pos' : 'neutral'}" style="width: ${Math.min(100, Math.abs(item.value) * 100)}%;"></div>
        </div>
      `;
      container.appendChild(row);
    });

    modalExplanation.classList.add('open');
  });

  btnCloseExplanation.addEventListener('click', () => modalExplanation.classList.remove('open'));
  btnCloseExplanationFooter.addEventListener('click', () => modalExplanation.classList.remove('open'));

  btnFullTimeSeries.addEventListener('click', () => {
    modalTimeSeries.classList.add('open');
    renderModalTrendChart();
  });

  btnCloseTimeSeries.addEventListener('click', () => modalTimeSeries.classList.remove('open'));

  function renderModalTrendChart() {
    const ctx = document.getElementById('modalTrendChart');
    if (!ctx) return;

    const labels = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7', 'Day 8', 'Day 9', 'Day 10'];
    const confData = [];
    const bustData = [];

    for (let day = 1; day <= 10; day++) {
      const dKey = `Day_${day}`;
      const dInfo = SIMULATION_DATA[dKey]?.states[currentRegion];
      if (dInfo) {
        confData.push(dInfo.confidence);
        bustData.push(dInfo.bust_probability);
      }
    }

    if (modalChartInstance) modalChartInstance.destroy();

    modalChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Forecast Confidence (%)',
            data: confData,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.15)',
            fill: true,
            tension: 0.3
          },
          {
            label: 'Bust Probability P(BUST) (%)',
            data: bustData,
            borderColor: '#ef4444',
            borderDash: [5, 5],
            fill: false,
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 100 }
        }
      }
    });
  }

  // Close modals when clicking overlay background
  [modalExplanation, modalTimeSeries].forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.remove('open');
    });
  });

  // --------------------------------------------------------------------------
  // 10. Start Dashboard
  // --------------------------------------------------------------------------
  initMap();
  updateDashboard();
});
