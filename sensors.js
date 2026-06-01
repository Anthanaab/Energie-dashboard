// ===== Configuration centralisée des capteurs Home Assistant =====
// Source de vérité unique, importée par le poller (collecte) et le serveur (lecture).

// Capteurs énergie principaux. Tous se remettent à zéro à minuit (reset-aware),
// SAUF currentPower (puissance instantanée en W).
const MAIN = {
  hp:           'sensor.ecojoko_consommation_hp_reseau',          // kWh import HP, reset minuit
  hc:           'sensor.ecojoko_consommation_hc_reseau',          // kWh import HC, reset minuit
  surplus:      'sensor.surplus_de_production_positif',           // kWh injecté réseau (positif), reset minuit
  production:   'sensor.envoy_122303081421_production_d_energie_du_jour', // kWh prod solaire, reset minuit
  currentPower: 'sensor.ecojoko_consommation_temps_reel',         // W instantané, PAS de reset (peut être négatif = export)
  solarPower:   'sensor.envoy_122303081421_current_power_production', // W production solaire instantanée (flux solaire)
};

// Capteur eau (litres, reset minuit)
const WATER = 'sensor.consommation_eau_totale';

// Prises connectées : [entité_energy, entité_power, nom, icône]
const DEVICES = [
  ['sensor.prise_rack_energy',                 'sensor.prise_rack_power',                 'Rack',                '🖥️'],
  ['sensor.prise_tv_energy',                   'sensor.prise_tv_power',                   'TV',                  '📺'],
  ['sensor.prise_proxmox_energy',              'sensor.prise_proxmox_power',              'Proxmox (PC Gaming)', '💻'],
  ['sensor.prise_grenier_energy',              'sensor.prise_grenier_power',              'Grenier',             '🏠'],
  ['sensor.prise_pc_ss_energy',                'sensor.prise_pc_ss_power',                'PC Secondaire',       '🖥️'],
  ['sensor.prise_sdb_energy',                  'sensor.prise_sdb_power',                  'Salle de Bain',       '🚿'],
  ['sensor.prise_pompe_energy',                'sensor.prise_pompe_power',                'Pompe',               '💦'],
  ['sensor.prise_buffet_energy',               'sensor.prise_buffet_power',               'Buffet (Salon)',      '🪑'],
  ['sensor.garage_prise_porte_garage_192_energy', 'sensor.garage_prise_porte_garage_192_power', 'Porte Garage',  '🚪'],
  ['sensor.garage_prise_garage_194_energy',    'sensor.garage_prise_garage_194_power',    'Garage',              '🚗'],
];

// Liste plate de toutes les entités à interroger/stocker
const ALL_ENTITIES = [
  ...Object.values(MAIN),
  WATER,
  ...DEVICES.flatMap(([e, p]) => [e, p]),
];

module.exports = { MAIN, WATER, DEVICES, ALL_ENTITIES };
