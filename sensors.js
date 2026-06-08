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
  ['sensor.prise_tv_energy',                   'sensor.prise_tv_power',                   'TV Salon',            '📺'],
  ['sensor.prise_bambu_energy',                'sensor.prise_bambu_power',                'Bambu (Imprimante 3D)', '🖨️'],
  ['sensor.prise_grenier_energy',              'sensor.prise_grenier_power',              'Grenier',             '🏠'],
  ['sensor.prise_pc_ss_energy',                'sensor.prise_pc_ss_power',                'PC Secondaire',       '🖥️'],
  ['sensor.prise_sdb_energy',                  'sensor.prise_sdb_power',                  'Salle de Bain',       '🚿'],
  ['sensor.prise_pompe_energy',                'sensor.prise_pompe_power',                'Pompe',               '💦'],
  ['sensor.prise_buffet_energy',               'sensor.prise_buffet_power',               'Buffet (Salon)',      '🪑'],
  ['sensor.garage_prise_porte_garage_electric_consumption_kwh', 'sensor.garage_prise_porte_garage_power', 'Porte Garage', '🚪'],
  ['sensor.garage_prise_garage_electric_consumption_kwh',       'sensor.garage_prise_garage_power',       'Garage',        '🚗'],
  ['sensor.bureau_prise_bureau_jeremy_electric_consumption_kwh', 'sensor.bureau_prise_bureau_jeremy_power', 'Bureau Jérémy', '🖥️'],
  ['sensor.bureau_prise_bureau_marine_electric_consumption_kwh', 'sensor.bureau_prise_bureau_marine_power', 'Bureau Marine', '🖥️'],
  ['sensor.chambre_prise_chevet_jeremy_electric_consumption_kwh', 'sensor.chambre_prise_chevet_jeremy_power', 'Chevet Jérémy', '🛏️'],
  ['sensor.chambre_prise_chevet_marine_electric_consumption_kwh', 'sensor.chambre_prise_chevet_marine_power', 'Chevet Marine', '🛏️'],
  ['sensor.mezzanine_prise_atelier_electric_consumption_kwh',    'sensor.mezzanine_prise_atelier_power',    'Atelier',       '🔧'],
  ['sensor.entree_prise_tablette_electric_consumption_kwh',      'sensor.entree_prise_tablette_power',      'Tablette',      '📱'],
  ['sensor.cuisine_prise_thermomix_electric_consumption_kwh',    'sensor.cuisine_prise_thermomix_power',    'Thermomix',     '🍲'],
  ['sensor.cuisine_prise_cafe_electric_consumption_kwh',         'sensor.cuisine_prise_cafe_electric_consumption_w', 'Café',  '☕'],
  ['sensor.sdb_prise_pharma_electric_consumption_kwh',           'sensor.sdb_prise_pharma_power',           'Pharma (SdB)',  '💊'],
  ['sensor.chambre_prise_tv_electric_consumption_kwh',           'sensor.chambre_prise_tv_power',           'TV Chambre',    '📺'],
];

// Liste plate de toutes les entités à interroger/stocker
const ALL_ENTITIES = [
  ...Object.values(MAIN),
  WATER,
  ...DEVICES.flatMap(([e, p]) => [e, p]),
];

module.exports = { MAIN, WATER, DEVICES, ALL_ENTITIES };
