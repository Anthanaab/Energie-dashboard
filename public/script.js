// ===== Configuration =====
const HA_CONFIG = {
    priceHP: 0.1876,    // €/kWh heures pleines
    priceHC: 0.1456,    // €/kWh heures creuses
    priceSurplus: 0.13, // €/kWh vendu au réseau
    priceWater: 4.82    // €/m³
};

// ===== Sensors Configuration =====
const SENSORS = {
    // Entity IDs for mapping server response (must match server.js)
    entities: {
        consumptionToday: 'sensor.envoy_122303081421_consommation_d_energie_du_jour',
        lifetimeConsumption: 'sensor.envoy_122303081421_lifetime_net_energy_consumption',
        lifetimeProduction: 'sensor.envoy_122303081421_lifetime_net_energy_production',
        productionToday: 'sensor.envoy_122303081421_production_d_energie_du_jour',
        currentPower: 'sensor.ecojoko_consommation_temps_reel',
        surplus: 'sensor.ecojoko_surplus_de_production',
        hp: 'sensor.ecojoko_consommation_hp_reseau',
        hc: 'sensor.ecojoko_consommation_hc_reseau'
    },
    // Water sensor
    water: {
        total: 'sensor.consommation_eau_totale'
    },
    // Individual devices (name + icon only — data comes from server)
    devices: [
        { name: 'Rack', icon: '🖥️' },
        { name: 'TV', icon: '📺' },
        { name: 'Proxmox (PC Gaming)', icon: '💻' },
        { name: 'Grenier', icon: '🏠' },
        { name: 'PC Secondaire', icon: '🖥️' },
        { name: 'Salle de Bain', icon: '🚿' },
        { name: 'Pompe', icon: '💦' },
        { name: 'Buffet (Salon)', icon: '🪑' },
        { name: 'Porte Garage', icon: '🚪' },
        { name: 'Garage', icon: '🚗' }
    ]
};

// ===== State Variables =====
let energyChart, powerChart, waterChart;
let currentData = {
    currentPower: 0,
    surplus: 0,
    productionToday: 0,
    todayConsumption: 0,
    periodHP: 0,
    periodHC: 0,
    periodSurplus: 0,
    periodProduction: 0,
    periodConsumption: 0,
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
    surplusPower: document.getElementById('surplus-power'),
    waterToday: document.getElementById('water-today'),
    waterCostToday: document.getElementById('water-cost-today'),
    hpValue: document.getElementById('hp-value'),
    hcValue: document.getElementById('hc-value'),
    peakPower: document.getElementById('peak-power'),
    selfConsumption: document.getElementById('self-consumption'),
    selfSufficiency: document.getElementById('self-sufficiency'),
    surplusRevenue: document.getElementById('surplus-revenue'),
    surplusKwh: document.getElementById('surplus-kwh'),
    lastUpdate: document.getElementById('last-update'),
    footerTime: document.getElementById('footer-time'),
    consumersGrid: document.getElementById('consumers-grid'),
    periodSelect: document.getElementById('period-select'),
    refreshBtn: document.getElementById('refresh-btn'),
    autorefreshBtn: document.getElementById('autorefresh-btn'),
    refreshIntervalSelect: document.getElementById('refresh-interval-select'),
    loadingOverlay: document.getElementById('loading-overlay')
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

const getHistory = async (entityId, period) => {
    const now = new Date();
    let startTime;
    
    switch (period) {
        case 'hour': startTime = new Date(now.getTime() - 1 * 60 * 60 * 1000); break;
        case 'day': startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
        case 'week': startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
        case 'month': startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
        default: startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
    
    const startISO = toLocalISO(startTime);
    const endISO = toLocalISO(now);

    const data = await fetchHA(`history/period/${startISO}?filter=${entityId}&end_time=${endISO}`);
    return data ? data[0] || [] : [];
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

const historyDelta = (history) => {
    const valid = history.filter(h => !isNaN(parseFloat(h.state)));
    if (valid.length < 2) return 0;
    return Math.max(0, parseFloat(valid[valid.length - 1].state) - parseFloat(valid[0].state));
};

// Même chose mais autorise les valeurs négatives (ex: net Enphase qui diminue quand export > import)
const historyDeltaSigned = (history) => {
    const valid = history.filter(h => !isNaN(parseFloat(h.state)));
    if (valid.length < 2) return 0;
    return parseFloat(valid[valid.length - 1].state) - parseFloat(valid[0].state);
};

// Pour les capteurs qui se remettent à zéro (HP/HC journaliers)
const historyDeltaWithResets = (history) => {
    const valid = history.filter(h => !isNaN(parseFloat(h.state)));
    if (valid.length < 2) return 0;
    let total = 0;
    let segStart = parseFloat(valid[0].state);
    for (let i = 1; i < valid.length; i++) {
        const curr = parseFloat(valid[i].state);
        const prev = parseFloat(valid[i - 1].state);
        if (curr < prev) {
            total += prev - segStart;
            segStart = curr;
        }
    }
    return Math.max(0, total + parseFloat(valid[valid.length - 1].state) - segStart);
};

// Pour les capteurs négatifs qui se remettent à zéro (ex: surplus Ecojoko)
const historyDeltaWithResetsAbs = (history) => {
    const valid = history.filter(h => !isNaN(parseFloat(h.state)));
    if (valid.length < 2) return 0;
    let total = 0;
    let segStart = Math.abs(parseFloat(valid[0].state));
    for (let i = 1; i < valid.length; i++) {
        const curr = Math.abs(parseFloat(valid[i].state));
        const prev = Math.abs(parseFloat(valid[i - 1].state));
        if (curr < prev) {
            total += prev - segStart;
            segStart = curr;
        }
    }
    return Math.max(0, total + Math.abs(parseFloat(valid[valid.length - 1].state)) - segStart);
};

const toLocalISO = (date) => {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
};

const getTrendEmoji = (value, previousValue) => {
    if (previousValue === null) return '';
    if (value > previousValue) return '↑';
    if (value < previousValue) return '↓';
    return '';
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
                label: 'Consommation eau (m³)',
                data: [],
                borderColor: '#0891b2',
                backgroundColor: 'rgba(8, 145, 178, 0.1)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#0891b2',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
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

// Calcule les valeurs cumulées d'un historique qui se remet à zéro (ex: compteur eau)
const historyCumulative = (history) => {
    const valid = history.filter(h => !isNaN(parseFloat(h.state)));
    if (valid.length === 0) return { values: [], labels: [] };

    const nums = valid.map(h => parseFloat(h.state));
    const cumulative = [0];
    let cumul = 0;
    let segStart = nums[0];

    for (let i = 1; i < nums.length; i++) {
        if (nums[i] < nums[i - 1]) {
            cumul += nums[i - 1] - segStart;
            segStart = nums[i];
        }
        cumulative.push(cumul + Math.max(0, nums[i] - segStart));
    }

    return {
        values: cumulative,
        labels: valid.map(h => formatDate(h.last_changed))
    };
};

// ===== Fetch Water Statistics (for long periods) =====
const getWaterStatistics = async (period) => {
    const now = new Date();
    let startTime;
    switch (period) {
        case 'week': startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
        case 'month': startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
        default: startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    const startISO = toLocalISO(startTime);
    const endISO = toLocalISO(now);

    const data = await fetchHA(`history/statistics_during_period?start_time=${startISO}&end_time=${endISO}&statistic_ids=${SENSORS.water.total}&period=day`);
    if (!data || !data[SENSORS.water.total]) return { total: 0, daily: [] };

    const stats = data[SENSORS.water.total];
    const daily = stats.map(s => ({
        date: new Date(s.start).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        sum: s.sum || 0
    }));

    const total = daily.reduce((acc, d) => acc + d.sum, 0);
    return { total, daily };
};

// ===== Fetch Water Data =====
const fetchWaterData = async (period) => {
    try {
        const toM3 = (liters) => liters / 1000;
        const lbl = PERIOD_LABELS[period];
        elements.labelWater.textContent = `Conso Eau ${lbl}`;
        elements.labelWaterCost.textContent = `Coût Eau ${lbl}`;

        // Pour 7j/30j, essayer statistiques HA (long-term) puis fallback historique brut
        let waterPeriodL = 0;
        let chartValues = [];
        let chartLabels = [];

        if (period === 'week' || period === 'month') {
            const { total, daily } = await getWaterStatistics(period);
            console.log('Water stats result:', { total, daily });
            if (total > 0 && daily.length > 0) {
                waterPeriodL = total;
                chartLabels = daily.map(d => d.date);
                chartValues = daily.map(d => d.sum);
            }
        }

        // Fallback: si stats vides ou pour 1h/24h, utiliser historique brut
        if (waterPeriodL === 0) {
            const periodHistory = await getHistory(SENSORS.water.total, period);
            console.log('Water raw history length:', periodHistory.length);
            waterPeriodL = historyDeltaWithResets(periodHistory);
            const cumul = historyCumulative(periodHistory);
            chartValues = cumul.values;
            chartLabels = cumul.labels;
        }

        const useLiters = period === 'hour' || period === 'day';
        const waterVal = useLiters ? waterPeriodL : toM3(waterPeriodL);
        const waterCost = toM3(waterPeriodL) * HA_CONFIG.priceWater;
        const waterUnit = useLiters ? 'L' : 'm³';

        elements.waterToday.textContent = useLiters ? formatNumber(waterPeriodL, 0) : formatNumber(waterVal, 3);
        document.getElementById('water-unit').textContent = waterUnit;
        elements.waterCostToday.textContent = formatNumber(waterCost, 2);

        if (waterChart) {
            waterChart.data.labels = chartLabels;
            waterChart.data.datasets[0].data = chartValues.map(v => toM3(v));
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

// ===== Update Top Consumers =====
const updateTopConsumers = () => {
    elements.consumersGrid.innerHTML = '';
    
    currentData.devices
        .sort((a, b) => b.energy - a.energy)
        .slice(0, 10)
        .forEach((device, index) => {
            const maxEnergy = Math.max(...currentData.devices.map(d => d.energy));
            const percentage = maxEnergy > 0 ? (device.energy / maxEnergy) * 100 : 0;
            
            const item = document.createElement('div');
            item.className = 'consumer-item';
            item.innerHTML = `
                <div class="consumer-rank">${index + 1}</div>
                <div class="consumer-info">
                    <div class="consumer-name">${device.icon} ${device.name}</div>
                </div>
                <div class="consumer-value">
                    <div class="consumer-energy">${formatNumber(device.energy, 1)} kWh</div>
                    <div class="consumer-power">${formatNumber(device.power, 1)} W</div>
                </div>
                <div class="consumer-bar" style="width: ${percentage}%"></div>
            `;
            elements.consumersGrid.appendChild(item);
        });
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
        currentData.periodConsumption = 0;
        updateUI();

        const data = await fetchHA(`all-energy-data?period=${period}`);
        if (!data) throw new Error('No data from server');

        // --- Current states ---
        const m = data.main;
        currentData.currentPower = m[SENSORS.entities.currentPower] || 0;
        currentData.surplus = Math.max(0, m[SENSORS.entities.surplus] || 0);
        currentData.productionToday = m[SENSORS.entities.productionToday] || 0;
        currentData.todayConsumption = (m[SENSORS.entities.hp] || 0) + (m[SENSORS.entities.hc] || 0);

        // --- Device data with icons ---
        currentData.devices = data.devices.map((d, i) => ({
            ...d,
            icon: SENSORS.devices[i]?.icon || ''
        }));

        // --- History for charts ---
        const h = data.history;
        const parseH = arr => arr.map(e => { const v = parseFloat(e.state); return isNaN(v) ? null : v; });

        const rawConsumption = parseH(h.consumption);
        const rawProduction = parseH(h.production);
        const firstConso = rawConsumption.find(v => v !== null) ?? 0;
        const firstProd = rawProduction.find(v => v !== null) ?? 0;

        currentData.history = {
            consumption: rawConsumption.map(v => v !== null ? Math.max(0, (v - firstConso) * 1000) : null),
            production: rawProduction.map(v => v !== null ? Math.max(0, (v - firstProd) * 1000) : null),
            power: parseH(h.power).map(v => v !== null ? v : null),
            timestamps: h.consumption.map(e => e.last_changed)
        };

        // --- Period deltas ---
        const hpHistory = h.hp || [];
        const hcHistory = h.hc || [];
        const surplusHistory = h.surplus || [];
        const consumptionHistory = h.consumption || [];
        const productionHistory = h.production || [];

        currentData.periodHP = historyDeltaWithResets(hpHistory);
        currentData.periodHC = historyDeltaWithResets(hcHistory);
        currentData.periodProduction = historyDelta(productionHistory) * 1000;
        currentData.periodConsumption = historyDeltaSigned(consumptionHistory) * 1000;
        // Surplus = réinjection réseau (capteur Ecojoko direct, valeurs négatives, reset journalier)
        currentData.periodSurplus = historyDeltaWithResetsAbs(surplusHistory);

        // Update UI
        updateUI();
        updateCharts();
        updateTopConsumers();

    } catch (error) {
        console.error('Error fetching data:', error);
        alert('Erreur lors de la récupération des données. Vérifie ta connexion à Home Assistant.');
    } finally {
        hideLoading();
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
    const showConsumption = currentData.periodConsumption;
    const showNetConsumption = showHP + showHC;

    elements.currentPower.textContent = formatNumber(currentData.currentPower, 0);
    elements.todayConsumption.textContent = formatNumber(showNetConsumption, 2);
    elements.todayProduction.textContent = formatNumber(showProduction, 2);
    elements.totalConsumption.textContent = formatNumber(showConsumption, 1);

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

    // Peak power (from history)
    const validPowers = currentData.history.power.filter(v => v !== null);
    const peakPower = validPowers.length > 0 ? Math.max(...validPowers) : 0;
    elements.peakPower.textContent = formatNumber(peakPower, 0);

    // Auto-consommation : production utilisée localement = prod − surplus injecté réseau
    // Autosuffisance : % de la conso totale couverte par le solaire
    const periodSurplus = currentData.periodSurplus || 0;
    const selfConsumed = Math.max(0, showProduction - periodSurplus);
    const totalLoad = showNetConsumption + selfConsumed;

    const selfConsumptionPct = showProduction > 0
        ? Math.min(100, (selfConsumed / showProduction) * 100)
        : 0;
    const selfSufficiencyPct = totalLoad > 0
        ? Math.min(100, (selfConsumed / totalLoad) * 100)
        : 0;

    elements.selfConsumption.textContent = formatNumber(selfConsumptionPct, 1);
    elements.selfSufficiency.textContent = formatNumber(selfSufficiencyPct, 1);
    
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
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-energy').style.display = activeTab === 'energy' ? '' : 'none';
            document.getElementById('tab-water').style.display = activeTab === 'water' ? '' : 'none';
            if (activeTab === 'water') {
                fetchWaterData(elements.periodSelect.value);
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
        elements.autorefreshBtn.textContent = autoRefreshEnabled ? '⏱ Auto' : '⏸ Pause';
        elements.autorefreshBtn.classList.toggle('autorefresh-on', autoRefreshEnabled);
        elements.autorefreshBtn.classList.toggle('autorefresh-off', !autoRefreshEnabled);
        applyAutoRefresh();
    });
};

// ===== Auto Refresh =====
let autoRefreshTimer = null;
let autoRefreshEnabled = true;

const applyAutoRefresh = () => {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (!autoRefreshEnabled) return;
    const seconds = parseInt(elements.refreshIntervalSelect.value, 10);
    autoRefreshTimer = setInterval(getCurrentRefreshFn, seconds * 1000);
};

const startAutoRefresh = () => {
    fetchAllData();
    applyAutoRefresh();
};

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    initWaterChart();
    initTabs();
    initEventListeners();
    startAutoRefresh();
});

// ===== Export for debugging =====
window.HADashboard = {
    sensors: SENSORS,
    currentData: currentData,
    fetchAllData: fetchAllData
};
