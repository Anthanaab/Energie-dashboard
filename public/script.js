// ===== Configuration =====
const HA_CONFIG = {
    priceHP: 0.1876,    // €/kWh heures pleines
    priceHC: 0.1456,    // €/kWh heures creuses
    priceSurplus: 0.13, // €/kWh vendu au réseau
    priceWater: 4.82    // €/m³
};

// ===== Sensors (icônes uniquement — entity IDs et calculs sont côté serveur) =====
// L'ordre doit correspondre à DEVICES dans sensors.js (le serveur renvoie les
// appareils dans ce même ordre).
const SENSORS = {
    devices: [
        { name: 'Rack', icon: '🖥️' },
        { name: 'TV Salon', icon: '📺' },
        { name: 'Bambu (Imprimante 3D)', icon: '🖨️' },
        { name: 'Grenier', icon: '🏠' },
        { name: 'PC Secondaire', icon: '🖥️' },
        { name: 'Salle de Bain', icon: '🚿' },
        { name: 'Pompe', icon: '💦' },
        { name: 'Buffet 1 (Salon)', icon: '🪑' },
        { name: 'Porte Garage', icon: '🚪' },
        { name: 'Garage', icon: '🚗' },
        { name: 'Bureau 1', icon: '🖥️' },
        { name: 'Bureau 2', icon: '🖥️' },
        { name: 'Chevet 1', icon: '🛏️' },
        { name: 'Chevet 2', icon: '🛏️' },
        { name: 'Atelier', icon: '🔧' },
        { name: 'Tablette', icon: '📱' },
        { name: 'Thermomix', icon: '🍲' },
        { name: 'Café', icon: '☕' },
        { name: 'Pharma (SdB)', icon: '💊' },
        { name: 'TV Chambre', icon: '📺' },
        { name: 'Buffet 2 (Salon)', icon: '🪑' }
    ]
};

// ===== State Variables =====
let energyChart, powerChart, waterChart, mixChart;
let prevData = { hp: 0, hc: 0, production: 0, surplus: 0 };
let sunTimes = { sunrise: 7, sunset: 20 }; // mis à jour depuis sun.sun via /api/weather
let currentData = {
    currentPower: 0,
    currentSolarPower: 0,
    surplus: 0,
    productionToday: 0,
    todayConsumption: 0,
    periodHP: 0,
    periodHC: 0,
    periodSurplus: 0,
    periodProduction: 0,
    peakPower: 0,
    history: { consumption: [], production: [], power: [], timestamps: [] },
    devices: []
};

// ===== DOM Elements =====
const elements = {
    currentPower: document.getElementById('current-power'),
    todayConsumption: document.getElementById('today-consumption'),
    todayProduction: document.getElementById('today-production'),
    totalConsumption: document.getElementById('total-consumption'),
    todayCost: document.getElementById('today-cost'),
    labelConsumption: document.getElementById('label-consumption'),
    labelProduction: document.getElementById('label-production'),
    labelTotal: document.getElementById('label-total'),
    labelWater: document.getElementById('label-water'),
    labelWaterCost: document.getElementById('label-water-cost'),
    labelWaterExt: document.getElementById('label-water-ext'),
    labelWaterExtCost: document.getElementById('label-water-ext-cost'),

    waterToday: document.getElementById('water-today'),
    waterCostToday: document.getElementById('water-cost-today'),
    waterExtToday: document.getElementById('water-ext-today'),
    waterExtCostToday: document.getElementById('water-ext-cost-today'),
    hpValue: document.getElementById('hp-value'),
    hcValue: document.getElementById('hc-value'),
    peakPower: document.getElementById('peak-power'),
    selfConsumption: document.getElementById('self-consumption'),
    selfSufficiency: document.getElementById('self-sufficiency'),
    surplusRevenue: document.getElementById('surplus-revenue'),
    surplusKwh: document.getElementById('surplus-kwh'),
    lastUpdate: document.getElementById('last-update'),
    footerTime: document.getElementById('footer-time'),
    periodSelect: document.getElementById('period-select'),
    refreshBtn: document.getElementById('refresh-btn'),
    autorefreshBtn: document.getElementById('autorefresh-btn'),
    refreshIntervalSelect: document.getElementById('refresh-interval-select'),
    loadingOverlay: document.getElementById('loading-overlay'),
    compareConsumption: document.getElementById('compare-consumption'),
    compareProduction: document.getElementById('compare-production'),
    bilanNetValue: document.getElementById('bilan-net-value'),
    co2AvoidedValue: document.getElementById('co2-avoided-value'),
    weatherWidget: document.getElementById('weather-widget'),
    exportCsvBtn: document.getElementById('export-csv-btn'),
    updateBtn: document.getElementById('update-btn'),
    updateStatus: document.getElementById('update-status'),
    settingsMain: document.getElementById('settings-main'),
    settingsWater: document.getElementById('settings-water'),
    settingsDevices: document.getElementById('settings-devices'),
    settingsAddDevice: document.getElementById('settings-add-device'),
    settingsSave: document.getElementById('settings-save'),
    settingsReset: document.getElementById('settings-reset'),
    settingsStatus: document.getElementById('settings-status')
};

// ===== Utility Functions =====
const fetchHA = async (endpoint) => {
    try {
        const response = await fetch(`/api/${endpoint}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('Error fetching HA data:', error);
        return null;
    }
};

const formatNumber = (num, decimals = 2) => {
    if (num === null || num === undefined) return '--';
    return num.toFixed(decimals).replace('.', ',');
};

const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
};

const PERIOD_LABELS = {
    hour: '1 Heure',
    day: '24 Heures',
    week: '7 Jours',
    month: '30 Jours'
};

// ===== Météo (Pirate Weather via HA) =====
const haConditionToInfo = (condition) => {
    const map = {
        'sunny':           { icon: '☀️',  desc: 'Ensoleillé' },
        'clear-night':     { icon: '🌙',  desc: 'Nuit claire' },
        'partlycloudy':    { icon: '⛅',  desc: 'Partiellement nuageux' },
        'cloudy':          { icon: '🌥️', desc: 'Nuageux' },
        'fog':             { icon: '🌫️', desc: 'Brouillard' },
        'rainy':           { icon: '🌧️', desc: 'Pluvieux' },
        'showers-day':     { icon: '🌦️', desc: 'Averses' },
        'showers-night':   { icon: '🌧️', desc: 'Averses nocturnes' },
        'pouring':         { icon: '🌧️', desc: 'Forte pluie' },
        'snowy':           { icon: '🌨️', desc: 'Neige' },
        'snowy-rainy':     { icon: '🌨️', desc: 'Neige et pluie' },
        'lightning':       { icon: '⚡',  desc: 'Orage' },
        'lightning-rainy': { icon: '⛈️', desc: 'Orage pluvieux' },
        'windy':           { icon: '🌬️', desc: 'Venteux' },
        'windy-variant':   { icon: '🌬️', desc: 'Très venteux' },
        'hail':            { icon: '🌨️', desc: 'Grêle' },
        'exceptional':     { icon: '⚠️',  desc: 'Conditions exceptionnelles' },
    };
    return map[condition] || { icon: '🌡️', desc: condition };
};

const fetchWeather = async () => {
    const widget = elements.weatherWidget;
    if (!widget) return;
    try {
        const data = await fetchHA('weather');
        if (!data || data.error) return;
        if (data.sunrise != null) sunTimes.sunrise = data.sunrise;
        if (data.sunset  != null) sunTimes.sunset  = data.sunset;
        const { icon, desc } = haConditionToInfo(data.condition);
        const uv = data.uv_index;
        const uvPct = uv != null ? Math.min(100, (uv / 11) * 100).toFixed(0) : null;
        const feelLike = data.apparent_temperature != null ? `Ressenti ${Math.round(data.apparent_temperature)}°C` : '';
        const humidity = data.humidity != null ? `<span class="weather-wind">💧 ${data.humidity}%</span>` : '';
        widget.innerHTML = `
            <div class="weather-main">
                <span class="weather-icon">${icon}</span>
                <div class="weather-temps">
                    <span class="weather-temp-main">${Math.round(data.temperature)}°C</span>
                    <span class="weather-temp-range">${feelLike}</span>
                </div>
                <span class="weather-desc">${desc}</span>
                <span class="weather-wind">💨 ${Math.round(data.wind_speed)} km/h</span>
                ${humidity}
            </div>
            ${uvPct !== null ? `
            <div class="weather-solar">
                <span class="weather-solar-label">Indice UV</span>
                <div class="solar-bar-wrap">
                    <div class="solar-bar"><div class="solar-fill" style="width:${uvPct}%"></div></div>
                    <span class="solar-value">UV ${uv.toFixed(0)}</span>
                </div>
            </div>` : ''}`;
    } catch (e) {
        console.error('fetchWeather error:', e);
    }
};

// ===== Comparaison période précédente =====
const compareBadge = (curr, prev, higherIsBetter) => {
    if (!prev || prev === 0 || curr === undefined) return '';
    const pct = ((curr - prev) / prev) * 100;
    const better = higherIsBetter ? pct >= 0 : pct <= 0;
    const cls = better ? 'compare-better' : 'compare-worse';
    const arrow = pct >= 0 ? '↑' : '↓';
    return `<span class="${cls}">${arrow} ${Math.abs(pct).toFixed(1).replace('.', ',')}% vs préc.</span>`;
};

// ===== Export CSV =====
const exportCSV = () => {
    const period = elements.periodSelect.value;
    const lbl = PERIOD_LABELS[period];
    const surplusKwh = currentData.periodSurplus || 0;
    const selfConsumed = Math.max(0, currentData.periodProduction - surplusKwh);
    const totalLoad = (currentData.periodHP + currentData.periodHC) + selfConsumed;
    const cost = currentData.periodHP * HA_CONFIG.priceHP + currentData.periodHC * HA_CONFIG.priceHC;
    const revenue = surplusKwh * HA_CONFIG.priceSurplus;
    const co2 = (currentData.periodProduction * 0.057).toFixed(3);
    const now = new Date().toLocaleString('fr-FR');

    let csv = `Exporté le;${now}\nPériode;${lbl}\n\n`;
    csv += `Réseau HP (kWh);Réseau HC (kWh);Production (kWh);Surplus injecté (kWh);Conso. Maison (kWh);Coût réseau (€);Revente (€);CO2 évité (kg)\n`;
    csv += `${currentData.periodHP.toFixed(3)};${currentData.periodHC.toFixed(3)};${currentData.periodProduction.toFixed(3)};${surplusKwh.toFixed(3)};${totalLoad.toFixed(3)};${cost.toFixed(2)};${revenue.toFixed(2)};${co2}\n\n`;
    csv += `Appareil;Énergie (kWh);Puissance actuelle (W)\n`;
    [...currentData.devices].sort((a, b) => b.energy - a.energy).forEach(d => {
        csv += `${d.name};${d.energy.toFixed(3)};${(d.power || 0).toFixed(1)}\n`;
    });

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `energie-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
};

// ===== Chart Setup =====
const initCharts = () => {
    // Energy Chart (Consumption & Production)
    const energyCtx = document.getElementById('energyChart').getContext('2d');
    energyChart = new Chart(energyCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Consommation',
                    data: [],
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: '#ef4444',
                    tension: 0.4,
                    fill: true,
                    spanGaps: true
                },
                {
                    label: 'Production',
                    data: [],
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: '#10b981',
                    tension: 0.4,
                    fill: true,
                    spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: '#1e293b',
                    titleColor: '#f8fafc',
                    bodyColor: '#f8fafc',
                    borderColor: '#334155',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(51, 65, 85, 0.5)'
                    },
                    ticks: {
                        color: '#94a3b8',
                        font: {
                            size: 11
                        }
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(51, 65, 85, 0.5)'
                    },
                    ticks: {
                        color: '#94a3b8',
                        font: {
                            size: 11
                        },
                        callback: (value) => `${value} kWh`
                    }
                }
            },
            interaction: {
                intersect: false,
                mode: 'index'
            }
        }
    });

    // Power Chart
    const powerCtx = document.getElementById('powerChart').getContext('2d');
    powerChart = new Chart(powerCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Puissance (W)',
                data: [],
                borderColor: '#2563eb',
                backgroundColor: 'rgba(37, 99, 235, 0.1)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#2563eb',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: '#1e293b',
                    titleColor: '#f8fafc',
                    bodyColor: '#f8fafc',
                    borderColor: '#334155',
                    borderWidth: 1,
                    callbacks: {
                        label: (context) => `${Math.round(context.parsed.y)} W`
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(51, 65, 85, 0.5)'
                    },
                    ticks: {
                        color: '#94a3b8',
                        font: {
                            size: 10
                        }
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(51, 65, 85, 0.5)'
                    },
                    ticks: {
                        color: '#94a3b8',
                        font: {
                            size: 10
                        },
                        callback: (value) => `${value} W`
                    }
                }
            }
        }
    });
};

// ===== Water Chart Init =====
const initWaterChart = () => {
    const ctx = document.getElementById('waterChart').getContext('2d');
    waterChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Eau (m³)',
                data: [],
                borderColor: '#0891b2',
                backgroundColor: 'rgba(8, 145, 178, 0.1)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#0891b2',
                tension: 0.4,
                fill: true
            }, {
                label: 'Eau Extérieur (m³)',
                data: [],
                borderColor: '#d97706',
                backgroundColor: 'rgba(217, 119, 6, 0.1)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#d97706',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, labels: { color: '#94a3b8', font: { size: 11 } } },
                tooltip: {
                    backgroundColor: '#1e293b',
                    titleColor: '#f8fafc',
                    bodyColor: '#f8fafc',
                    borderColor: '#334155',
                    borderWidth: 1,
                    callbacks: {
                        label: (context) => `${context.parsed.y.toFixed(3)} m³`
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(51, 65, 85, 0.5)' },
                    ticks: { color: '#94a3b8', font: { size: 11 } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(51, 65, 85, 0.5)' },
                    ticks: {
                        color: '#94a3b8',
                        font: { size: 11 },
                        callback: (value) => `${value} m³`
                    }
                }
            }
        }
    });
};

// ===== Mix Chart Init =====
const initMixChart = () => {
    const ctx = document.getElementById('mixChart').getContext('2d');
    mixChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Réseau HP', 'Réseau HC', 'Solaire autoconsommé'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: [
                    'rgba(245, 158, 11, 0.75)',
                    'rgba(59, 130, 246, 0.75)',
                    'rgba(16, 185, 129, 0.75)'
                ],
                borderColor: [
                    'rgba(245, 158, 11, 1)',
                    'rgba(59, 130, 246, 1)',
                    'rgba(16, 185, 129, 1)'
                ],
                borderWidth: 2,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '62%',
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { color: '#94a3b8', font: { size: 11 }, padding: 10 }
                },
                tooltip: {
                    backgroundColor: '#1e293b',
                    titleColor: '#f8fafc',
                    bodyColor: '#f8fafc',
                    borderColor: '#334155',
                    borderWidth: 1,
                    callbacks: {
                        label: (ctx) => {
                            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                            const pct = total > 0 ? (ctx.parsed / total * 100).toFixed(1).replace('.', ',') : '0';
                            return ` ${ctx.parsed.toFixed(2).replace('.', ',')} kWh (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
};

const updateMixChart = () => {
    if (!mixChart) return;
    const selfConsumed = Math.max(0, currentData.periodProduction - (currentData.periodSurplus || 0));
    mixChart.data.datasets[0].data = [currentData.periodHP, currentData.periodHC, selfConsumed];
    mixChart.update('smooth');
};

// ===== Fetch Water Data (depuis la DB via /api/water-data) =====
const fetchWaterData = async (period) => {
    try {
        const data = await fetchHA(`water-data?period=${period}`);
        if (!data) return;

        const toM3 = (liters) => liters / 1000;
        const lbl = PERIOD_LABELS[period];
        // Heure/24h → L, 7j/30j → m³
        const useLiters = period === 'hour' || period === 'day';

        const main = data.main || { liters: data.liters || 0, history: data.history || {} };
        const ext = data.ext || { liters: 0, history: {} };

        elements.labelWater.textContent = `Conso Eau ${lbl}`;
        elements.labelWaterCost.textContent = `Coût Eau ${lbl}`;
        elements.labelWaterExt.textContent = `Conso Eau Extérieur ${lbl}`;
        elements.labelWaterExtCost.textContent = `Coût Eau Extérieur ${lbl}`;

        const mainCost = toM3(main.liters) * HA_CONFIG.priceWater;
        const extCost = toM3(ext.liters) * HA_CONFIG.priceWater;

        elements.waterToday.textContent = useLiters ? formatNumber(main.liters, 0) : formatNumber(toM3(main.liters), 3);
        document.getElementById('water-unit').textContent = useLiters ? 'L' : 'm³';
        elements.waterCostToday.textContent = formatNumber(mainCost, 2);

        elements.waterExtToday.textContent = useLiters ? formatNumber(ext.liters, 0) : formatNumber(toM3(ext.liters), 3);
        document.getElementById('water-ext-unit').textContent = useLiters ? 'L' : 'm³';
        elements.waterExtCostToday.textContent = formatNumber(extCost, 2);

        if (waterChart) {
            waterChart.data.labels = (main.history.timestamps || []).map(formatDate);
            waterChart.data.datasets[0].data = (main.history.liters || []).map(toM3);
            waterChart.data.datasets[1].data = (ext.history.liters || []).map(toM3);
            waterChart.update('smooth');
        }
    } catch (error) {
        console.error('Erreur fetchWaterData:', error);
    }
};

// ===== Update Charts =====
const updateCharts = () => {
    if (!energyChart || !powerChart) return;

    energyChart.data.labels = currentData.history.timestamps.map(t => formatDate(t));
    energyChart.data.datasets[0].data = currentData.history.consumption;
    energyChart.data.datasets[1].data = currentData.history.production;
    energyChart.update('smooth');

    powerChart.data.labels = currentData.history.timestamps.map(t => formatDate(t));
    powerChart.data.datasets[0].data = currentData.history.power;
    powerChart.update('smooth');
};

// ===== Fetch All Data =====
const fetchAllData = async () => {
    try {
        showLoading();
        const period = elements.periodSelect.value;

        // Reset period deltas + UI immédiatement (évite d'afficher des données périmées)
        currentData.periodHP = 0;
        currentData.periodHC = 0;
        currentData.periodSurplus = 0;
        currentData.periodProduction = 0;
        currentData.peakPower = 0;
        updateUI();

        const data = await fetchHA(`all-energy-data?period=${period}`);
        if (!data) throw new Error('No data from server');

        // --- États courants ---
        currentData.currentPower = data.main.currentPower ?? 0;
        currentData.currentSolarPower = data.main.currentSolarPower ?? 0;

        // --- Scalaires de période (calculés côté serveur, pleine résolution) ---
        currentData.periodHP = data.period.hp ?? 0;
        currentData.periodHC = data.period.hc ?? 0;
        currentData.periodSurplus = data.period.surplus ?? 0;
        currentData.periodProduction = data.period.production ?? 0;
        currentData.peakPower = data.period.peakPower ?? 0;

        // --- Appareils (icônes incluses depuis le serveur, config dynamique) ---
        currentData.devices = (data.devices || []).map((d) => ({
            ...d,
            icon: d.icon || ''
        }));

        // --- Séries graphiques (déjà en kWh cumulés / W, downsamplées par le serveur) ---
        currentData.history = {
            timestamps: data.history.timestamps || [],
            consumption: data.history.consumption || [],
            production: data.history.production || [],
            power: data.history.power || []
        };

        // --- Période précédente (comparaison) ---
        if (data.prev) prevData = data.prev;

        // Update UI
        updateUI();
        updateCharts();

    } catch (error) {
        console.error('Error fetching data:', error);
    } finally {
        hideLoading();
    }
};

// ===== Solar Flow Visualization =====
const updateSolarArc = () => {
    const sun      = document.getElementById('arc-sun');
    if (!sun) return;
    const sunGlow  = document.getElementById('arc-sun-glow');
    const sunHaze  = document.getElementById('arc-sun-haze');
    const sunRays  = document.getElementById('arc-sun-rays');
    const sunProd  = document.getElementById('arc-sun-prod');
    const moon     = document.getElementById('arc-moon');
    const statusEl = document.getElementById('arc-status');
    const gridVal  = document.getElementById('arc-grid-val');
    const houseVal = document.getElementById('arc-house-val');
    const solarVal = document.getElementById('arc-solar-val');
    const flowGrid  = document.getElementById('flow-grid');
    const flowSolar = document.getElementById('flow-solar');
    const timeRise  = document.getElementById('arc-time-rise');
    const timeNoon  = document.getElementById('arc-time-noon');
    const timeSet   = document.getElementById('arc-time-set');

    const now  = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const SUNRISE = sunTimes.sunrise, SUNSET = sunTimes.sunset;

    // Mise à jour des labels horaires
    const fmtH = h => { const hh = Math.floor(h); const mm = Math.round((h - hh) * 60); return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`; };
    if (timeRise) timeRise.textContent = fmtH(SUNRISE);
    if (timeSet)  timeSet.textContent  = fmtH(SUNSET);
    if (timeNoon) timeNoon.textContent = fmtH((SUNRISE + SUNSET) / 2);
    const t = (hour - SUNRISE) / (SUNSET - SUNRISE);
    const isDay = t >= 0 && t <= 1;

    if (isDay) {
        // Quadratic bezier P0=(160,128) P1=(760,12) P2=(1360,128)
        const x = (1-t)*(1-t)*160  + 2*t*(1-t)*760 + t*t*1360;
        const y = (1-t)*(1-t)*128  + 2*t*(1-t)*12  + t*t*128;

        sun.setAttribute('cx', x.toFixed(1));
        sun.setAttribute('cy', y.toFixed(1));
        sun.setAttribute('opacity', '1');

        if (sunGlow) { sunGlow.setAttribute('cx', x.toFixed(1)); sunGlow.setAttribute('cy', y.toFixed(1)); sunGlow.classList.add('sun-active'); }
        if (sunHaze) { sunHaze.setAttribute('cx', x.toFixed(1)); sunHaze.setAttribute('cy', y.toFixed(1)); sunHaze.setAttribute('opacity', '0.85'); }
        if (sunRays) { sunRays.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`); sunRays.setAttribute('opacity', '1'); }
        if (moon)    moon.setAttribute('opacity', '0');

        const sp = currentData.currentSolarPower || 0;
        if (sunProd) {
            if (sp > 5) {
                sunProd.setAttribute('x', x.toFixed(1));
                sunProd.setAttribute('y', (y - 17).toFixed(1));
                sunProd.setAttribute('opacity', '1');
                sunProd.textContent = sp >= 1000 ? `${(sp/1000).toFixed(2)} kW ⚡` : `${Math.round(sp)} W ⚡`;
            } else {
                sunProd.setAttribute('opacity', '0');
            }
        }
    } else {
        sun.setAttribute('opacity', '0');
        if (sunGlow) sunGlow.classList.remove('sun-active');
        if (sunHaze) sunHaze.setAttribute('opacity', '0');
        if (sunRays) sunRays.setAttribute('opacity', '0');
        if (sunProd) sunProd.setAttribute('opacity', '0');
        if (moon)    moon.setAttribute('opacity', '1');
    }

    const cp = currentData.currentPower || 0;
    const sp = currentData.currentSolarPower || 0;
    const isExporting = cp < -50;
    const isImporting = cp > 50;
    // Quand Enphase est en retard (sp=0) mais on exporte, on sait que la prod est >= |cp|
    const displaySp = sp > 5 ? sp : (isExporting ? Math.abs(cp) : 0);
    const homeLoad = Math.max(0, displaySp + cp);
    const fmtW = w => { const a = Math.abs(w); return a >= 1000 ? `${(a/1000).toFixed(1)} kW` : `${Math.round(a)} W`; };

    if (gridVal)  gridVal.textContent  = fmtW(cp);
    if (houseVal) houseVal.textContent = fmtW(homeLoad);
    if (solarVal) solarVal.textContent = displaySp > 0 ? fmtW(displaySp) : '--';

    if (statusEl) {
        let label = 'VEILLE', color = 'rgba(148,163,184,0.45)';
        if ((sp > 50 || displaySp > 50) && isExporting) { label = 'EXPORT';     color = 'rgba(52,211,153,0.8)'; }
        else if (sp > 50)                                 { label = 'PRODUCTION'; color = 'rgba(251,191,36,0.8)'; }
        else if (isExporting)                             { label = 'EXPORT';     color = 'rgba(52,211,153,0.8)'; }
        else if (isImporting)                             { label = 'IMPORT';     color = 'rgba(129,140,248,0.8)'; }
        statusEl.textContent = label;
        statusEl.setAttribute('fill', color);
    }

    // Flux : setAttribute requis pour SVG (className non fiable sur éléments SVG)
    // Couleur verte quand export (house→grid), bleue pour import, ambrée pour solaire→maison
    if (flowGrid) {
        if (Math.abs(cp) < 50) {
            flowGrid.setAttribute('class', 'flow-line flow-inactive');
            flowGrid.style.stroke = 'rgba(129,140,248,0.92)';
        } else if (isImporting) {
            flowGrid.setAttribute('class', 'flow-line');
            flowGrid.style.stroke = 'rgba(129,140,248,0.92)';
        } else {
            flowGrid.setAttribute('class', 'flow-line flow-reverse');
            flowGrid.style.stroke = 'rgba(52,211,153,0.92)';
        }
    }
    if (flowSolar) {
        if (sp > 5 || isExporting) {
            flowSolar.setAttribute('class', 'flow-line flow-reverse');
            flowSolar.style.stroke = 'rgba(251,191,36,0.92)';
        } else {
            flowSolar.setAttribute('class', 'flow-line flow-inactive');
        }
    }
};

// ===== Update UI =====
const updateUI = () => {
    const period = elements.periodSelect.value;
    const lbl = PERIOD_LABELS[period];

    // Labels dynamiques
    elements.labelConsumption.textContent = `Réseau ${lbl} (HP+HC)`;
    elements.labelProduction.textContent = `Production Solaire ${lbl}`;
    elements.labelTotal.textContent = `Conso. Maison ${lbl}`;

    const showHP = currentData.periodHP;
    const showHC = currentData.periodHC;
    const showProduction = currentData.periodProduction;
    const showNetConsumption = showHP + showHC;

    const isExporting = currentData.currentPower < 0;
    elements.currentPower.textContent = formatNumber(Math.abs(currentData.currentPower), 0);
    const badge = document.getElementById('power-export-badge');
    if (badge) badge.style.display = isExporting ? 'inline-block' : 'none';
    document.querySelector('.stat-card.featured').classList.toggle('exporting', isExporting);

    elements.todayConsumption.textContent = formatNumber(showNetConsumption, 2);
    elements.todayProduction.textContent = formatNumber(showProduction, 2);

    // Coût réseau
    const cost = showHP * HA_CONFIG.priceHP + showHC * HA_CONFIG.priceHC;
    elements.todayCost.textContent = formatNumber(cost, 2);

    // Revente surplus
    const surplusKwh = currentData.periodSurplus || 0;
    const surplusRevenue = surplusKwh * HA_CONFIG.priceSurplus;
    elements.surplusKwh.textContent = formatNumber(surplusKwh, 2);
    elements.surplusRevenue.textContent = formatNumber(surplusRevenue, 2);

    // HP / HC breakdown
    elements.hpValue.textContent = formatNumber(showHP, 2);
    elements.hcValue.textContent = formatNumber(showHC, 2);

    // Pic de puissance (calculé côté serveur sur la pleine résolution)
    elements.peakPower.textContent = formatNumber(currentData.peakPower, 0);

    // Conso. Maison = réseau (HP+HC) + auto-consommation solaire
    // Plus précis que le net Enphase qui peut être négatif lors d'export important
    const periodSurplus = currentData.periodSurplus || 0;
    const selfConsumed = Math.max(0, showProduction - periodSurplus);
    const totalLoad = showNetConsumption + selfConsumed;
    elements.totalConsumption.textContent = formatNumber(totalLoad, 1);

    const selfConsumptionPct = showProduction > 0
        ? Math.min(100, (selfConsumed / showProduction) * 100)
        : 0;
    const selfSufficiencyPct = totalLoad > 0
        ? Math.min(100, (selfConsumed / totalLoad) * 100)
        : 0;

    elements.selfConsumption.textContent = formatNumber(selfConsumptionPct, 1);
    elements.selfSufficiency.textContent = formatNumber(selfSufficiencyPct, 1);

    // Bilan Net (€)
    const bilanNet = surplusRevenue - cost;
    if (elements.bilanNetValue) {
        elements.bilanNetValue.textContent = `${bilanNet >= 0 ? '+' : ''}${formatNumber(bilanNet, 2)} €`;
        elements.bilanNetValue.style.color = bilanNet >= 0 ? '#34d399' : '#f87171';
    }

    // CO2 évité (52 g/kWh — facteur moyen réseau français)
    const co2Kg = currentData.periodProduction * 0.057;
    if (elements.co2AvoidedValue) {
        elements.co2AvoidedValue.textContent = co2Kg >= 1
            ? `${formatNumber(co2Kg, 2)} kg`
            : `${formatNumber(co2Kg * 1000, 0)} g`;
    }

    // Comparaison période précédente
    if (elements.compareConsumption) {
        elements.compareConsumption.innerHTML = compareBadge(showNetConsumption, prevData.hp + prevData.hc, false);
    }
    if (elements.compareProduction) {
        elements.compareProduction.innerHTML = compareBadge(showProduction, prevData.production, true);
    }

    // Mix chart
    updateMixChart();

    // Solar arc
    updateSolarArc();

    // Update time
    const now = new Date();
    elements.lastUpdate.textContent = now.toLocaleTimeString('fr-FR');
    elements.footerTime.textContent = now.toLocaleDateString('fr-FR', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
};

// ===== Loading =====
const showLoading = () => {
    elements.loadingOverlay.style.display = 'flex';
};

const hideLoading = () => {
    setTimeout(() => {
        elements.loadingOverlay.style.display = 'none';
    }, 500);
};

// ===== Tab Switching =====
let activeTab = 'energy';

const getCurrentRefreshFn = () => {
    return activeTab === 'water'
        ? () => fetchWaterData(elements.periodSelect.value)
        : fetchAllData;
};

const initTabs = () => {
    const TABS = ['energy', 'water', 'settings'];
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            TABS.forEach(t => {
                const el = document.getElementById('tab-' + t);
                if (el) el.style.display = (t === activeTab) ? '' : 'none';
            });
            if (activeTab === 'water') {
                fetchWaterData(elements.periodSelect.value);
            } else if (activeTab === 'settings') {
                loadSettings();
            }
        });
    });
};

// ===== Event Listeners =====
const initEventListeners = () => {
    elements.refreshBtn.addEventListener('click', () => getCurrentRefreshFn()());

    elements.periodSelect.addEventListener('change', () => getCurrentRefreshFn()());

    elements.refreshIntervalSelect.addEventListener('change', () => {
        applyAutoRefresh();
    });

    elements.autorefreshBtn.addEventListener('click', () => {
        autoRefreshEnabled = !autoRefreshEnabled;
        syncAutoRefreshUI();
        applyAutoRefresh();
    });

    if (elements.exportCsvBtn) {
        elements.exportCsvBtn.addEventListener('click', exportCSV);
    }

    if (elements.updateBtn) {
        elements.updateBtn.addEventListener('click', async () => {
            elements.updateBtn.disabled = true;
            const say = (msg) => {
                console.log('[MAJ]', msg);
                if (elements.updateStatus) elements.updateStatus.textContent = msg;
                return msg;
            };
            say('⇅ Mise à jour en cours...');
            try {
                const resp = await fetch('/api/update', { method: 'POST' });
                const data = await resp.json().catch(() => ({}));
                if (resp.ok && data.ok) {
                    if (data.upToDate) {
                        say('✓ Déjà à jour');
                        alert('✔ Déjà à jour — aucune mise à jour disponible.');
                        setTimeout(() => { say(''); elements.updateBtn.disabled = false; }, 4000);
                    } else {
                        say('✔ MAJ OK — redémarrage...');
                        alert('✔ Mise à jour appliquée. Le dashboard redémarre et sera rechargé...');
                        setTimeout(() => location.reload(), 2000);
                    }
                } else {
                    const err = data.error || ('HTTP ' + resp.status);
                    say('✗ Échec : ' + err);
                    alert('✗ Échec de la mise à jour :\n' + err);
                    elements.updateBtn.disabled = false;
                }
            } catch (e) {
                console.error('[MAJ] erreur', e);
                say('✗ Erreur réseau');
                alert('✗ Erreur réseau : ' + (e && e.message));
                elements.updateBtn.disabled = false;
            }
        });
    }
};

// ===== Auto Refresh =====
let autoRefreshTimer = null;
let autoRefreshEnabled = false;   // désactivé par défaut — cliquer sur ⏸ Pause pour activer

const syncAutoRefreshUI = () => {
    if (!elements.autorefreshBtn) return;
    elements.autorefreshBtn.textContent = autoRefreshEnabled ? '⏱ Auto' : '⏸ Pause';
    elements.autorefreshBtn.classList.toggle('autorefresh-on', autoRefreshEnabled);
    elements.autorefreshBtn.classList.toggle('autorefresh-off', !autoRefreshEnabled);
};

const applyAutoRefresh = () => {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (!autoRefreshEnabled) return;
    const seconds = parseInt(elements.refreshIntervalSelect.value, 10);
    autoRefreshTimer = setInterval(() => getCurrentRefreshFn()(), seconds * 1000);
};

const startAutoRefresh = () => {
    syncAutoRefreshUI();   // reflète l'état par défaut (Pause) dès le chargement
    fetchAllData();        // charge les données une fois au démarrage
    applyAutoRefresh();
};

// ===== Réglages capteurs (menu ⚙️) =====
const MAIN_LABELS = {
    hp: 'Heures Pleines (import réseau)',
    hc: 'Heures Creuses (import réseau)',
    surplus: 'Surplus injecté (kWh)',
    production: 'Production solaire (kWh)',
    currentPower: 'Puissance instantanée (W)',
    solarPower: 'Puissance solaire (W)'
};

let settingsData = null;

const escAttr = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const inputRow = (label, key, value, group) =>
    `<div class="settings-row">
        <label>${label}</label>
        <input type="text" data-group="${group}" data-key="${key}" value="${escAttr(value)}" spellcheck="false" autocomplete="off">
    </div>`;

const renderMainSettings = () => {
    if (!elements.settingsMain) return;
    const m = (settingsData && settingsData.main) || {};
    elements.settingsMain.innerHTML = Object.keys(MAIN_LABELS).map(k =>
        inputRow(MAIN_LABELS[k], k, m[k], 'main')).join('');
};

const renderWaterSettings = () => {
    if (!elements.settingsWater) return;
    const w = (settingsData && settingsData.water) || {};
    elements.settingsWater.innerHTML = [
        inputRow('Compteur principal (litres)', 'main', w.main, 'water'),
        inputRow('Compteur extérieur (litres)', 'ext', w.ext, 'water')
    ].join('');
};

const renderDevicesSettings = () => {
    if (!elements.settingsDevices) return;
    const list = (settingsData && settingsData.devices) || [];
    elements.settingsDevices.innerHTML = list.map((d, i) => `
        <div class="settings-device-row">
            <input data-f="name"   placeholder="Nom"               value="${escAttr(d.name)}"   title="Nom affiché">
            <input data-f="energy" placeholder="Entité énergie (kWh)" value="${escAttr(d.energy)}" spellcheck="false">
            <input data-f="power"  placeholder="Entité puissance (W)" value="${escAttr(d.power)}"  spellcheck="false">
            <input data-f="icon"   placeholder="🔌"               value="${escAttr(d.icon)}"    style="width:56px" title="Icône">
            <button class="remove-device" data-i="${i}" type="button" title="Supprimer cette prise">🗑</button>
        </div>`).join('');
};

const renderSettings = () => { renderMainSettings(); renderWaterSettings(); renderDevicesSettings(); };

const collectSettings = () => {
    const data = { main: {}, water: {}, devices: [] };
    document.querySelectorAll('#settings-main [data-key]').forEach(i => data.main[i.dataset.key] = i.value.trim());
    document.querySelectorAll('#settings-water [data-key]').forEach(i => data.water[i.dataset.key] = i.value.trim());
    elements.settingsDevices.querySelectorAll('.settings-device-row').forEach(r => {
        data.devices.push({
            name: r.querySelector('[data-f="name"]').value.trim(),
            energy: r.querySelector('[data-f="energy"]').value.trim(),
            power: r.querySelector('[data-f="power"]').value.trim(),
            icon: r.querySelector('[data-f="icon"]').value.trim() || '🔌'
        });
    });
    return data;
};

const loadSettings = async () => {
    try {
        const resp = await fetch('/api/sensors');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        settingsData = await resp.json();
        renderSettings();
    } catch (e) {
        console.error('loadSettings', e);
    }
};

const saveSettings = async () => {
    if (!elements.settingsSave) return;
    elements.settingsSave.disabled = true;
    if (elements.settingsStatus) elements.settingsStatus.textContent = 'Enregistrement...';
    try {
        const resp = await fetch('/api/sensors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(collectSettings())
        });
        const d = await resp.json().catch(() => ({}));
        if (resp.ok) {
            settingsData = d;
            renderSettings();
            if (elements.settingsStatus) elements.settingsStatus.textContent = '✓ Sauvegardé';
            alert('✔ Configuration des capteurs enregistrée.');
        } else {
            const err = d.error || ('HTTP ' + resp.status);
            if (elements.settingsStatus) elements.settingsStatus.textContent = '✗ ' + err;
            alert('✗ Échec de l\'enregistrement :\n' + err);
        }
    } catch (e) {
        console.error('saveSettings', e);
        if (elements.settingsStatus) elements.settingsStatus.textContent = '✗ Erreur';
        alert('✗ Erreur réseau : ' + (e && e.message));
    }
    elements.settingsSave.disabled = false;
    setTimeout(() => { if (elements.settingsStatus) elements.settingsStatus.textContent = ''; }, 5000);
};

const resetSettings = async () => {
    if (!elements.settingsReset || !confirm('Revenir aux capteurs par défaut définis dans sensors.js ?')) return;
    try {
        const resp = await fetch('/api/sensors/reset', { method: 'POST' });
        const d = await resp.json().catch(() => ({}));
        settingsData = d;
        renderSettings();
        if (elements.settingsStatus) elements.settingsStatus.textContent = '✓ Réinitialisé';
        setTimeout(() => { if (elements.settingsStatus) elements.settingsStatus.textContent = ''; }, 5000);
    } catch (e) {
        alert('✗ Erreur réseau : ' + (e && e.message));
    }
};

const initSettings = () => {
    if (elements.settingsAddDevice) elements.settingsAddDevice.addEventListener('click', () => {
        settingsData = settingsData || { main: {}, water: {}, devices: [] };
        settingsData.devices.push({ name: '', energy: '', power: '', icon: '🔌' });
        renderDevicesSettings();
    });
    if (elements.settingsDevices) elements.settingsDevices.addEventListener('click', (e) => {
        const b = e.target.closest('.remove-device');
        if (!b || !settingsData) return;
        settingsData.devices.splice(Number(b.dataset.i), 1);
        renderDevicesSettings();
    });
    if (elements.settingsSave) elements.settingsSave.addEventListener('click', saveSettings);
    if (elements.settingsReset) elements.settingsReset.addEventListener('click', resetSettings);
};

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    initWaterChart();
    initMixChart();
    initTabs();
    initEventListeners();
    initSettings();
    startAutoRefresh();
    fetchWeather();
    setInterval(fetchWeather, 10 * 60 * 1000);
});

// ===== Export for debugging =====
window.HADashboard = {
    sensors: SENSORS,
    currentData: currentData,
    prevData: prevData,
    fetchAllData: fetchAllData,
    fetchWeather: fetchWeather,
    exportCSV: exportCSV
};
