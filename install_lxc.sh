#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  conso-maison — Create LXC with full energie-dashboard stack
#  (node.js + sqlite + systemd, from Home Assistant data)
#
#  Style: tteck/Proxmox VE Helper-Scripts
#  Run ON PROXMOX HOST (root) as a single line:
#
#    bash -c "$(wget -qLO - https://raw.githubusercontent.com/Anthanaab/Energie-dashboard/master/install_lxc.sh)"
#
#  Or locally:
#    bash install_lxc.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Couleurs ──
YW="\033[33m"; BL="\033[36m"; RD="\033[01;31m"; GN="\033[01;32m"; CL="\033[m"
msg_info()  { echo -e "${BL}[INFO]${CL}  ${YW}$1${CL}"; }
msg_ok()    { echo -e "${GN}[OK]${CL}    $1"; }
msg_error() { echo -e "${RD}[ERREUR]${CL} $1"; }

# ───────────────────────────────────────────────────────────────────
#  0. Paramètres (surchargés par variables d'env, style helper-script)
# ───────────────────────────────────────────────────────────────────

CT_ID="${CT_ID:-auto}"                   # ID du conteneur ('auto' = prochain libre, ou forcer avec "CT_ID=2xx")
CT_NAME="${CT_NAME:-conso-maison}"       # Nom
CT_PW="${CT_PW:-}"                       # Mot de passe root (auto-généré si vide)
# Réseau en DHCP (adresse attribuée par le routeur/le serveur DHCP du bridge)
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
CT_CORES="${CT_CORES:-1}"
CT_RAM="${CT_RAM:-1024}"
CT_SWAP="${CT_SWAP:-512}"
CT_DISK="${CT_DISK:-8}"
CT_STORAGE="${CT_STORAGE:-local-lvm}"    # stockage disque
CT_TEMPLATE_STORE="${CT_TEMPLATE_STORE:-local}"
CT_OS="${CT_OS:-debian}"
CT_VER="${CT_VER:-12}"                   # Debian 12
CT_TEMPLATE="${CT_TEMPLATE:-auto}"       # auto = dernière version Debian dispo (sinon ex. "debian-12-standard_12.7-1_amd64.tar.zst")

REPO_URL="${REPO_URL:-https://github.com/Anthanaab/Energie-dashboard.git}"
REPO_DIR="${REPO_DIR:-/opt/energie-dashboard}"
SERVICE_NAME="energie-dashboard"
SERVICE_USER="energie"
PORT=3000

# Home Assistant (⚠️ à renseigner — ou copié depuis Docker, voir plus bas)
HA_URL="${HA_URL:-http://192.168.40.214:8123}"
HA_TOKEN="${HA_TOKEN:-}"
# 🔒 Sécurité : le token HA n'est JAMAIS écrit dans un fichier committé. Il est
# stocké uniquement dans /etc/energie-dashboard.env (root, chmod 600), lu par le
# service systemd. Ne jamais l'exporter dans le repo, un commit, ou le terminal.

DB_PATH="/data/energie.db"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-30000}"
RETENTION_DAYS="${RETENTION_DAYS:-365}"

# Migration DB Docker (défaut OFF — active avec MIGRATE=1)
MIGRATE="${MIGRATE:-0}"
DOCKER_VOL="${DOCKER_VOL:-/var/lib/docker/volumes/energie-data/_data}"

# ───────────────────────────────────────────────────────────────────
#  1. Pré-vérifications
# ───────────────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then msg_error "Lancer en root sur l'hôte Proxmox."; exit 1; fi
if ! command -v pct >/dev/null 2>&1; then msg_error "'pct' introuvable — pas un hôte Proxmox."; exit 1; fi
if ! command -v pveam >/dev/null 2>&1; then msg_error "'pveam' absent."; exit 1; fi

# ───────────────────────────────────────────────────────────────────
#  1b. Attribution automatique de l'ID du conteneur
# ───────────────────────────────────────────────────────────────────
if [[ -z "$CT_ID" || "$CT_ID" == "auto" ]]; then
  msg_info "Aucun CT_ID fourni — recherche du prochain identifiant libre..."
  if command -v pvesh >/dev/null 2>&1; then
    CT_ID="$(pvesh get /cluster/nextid 2>/dev/null || true)"
  fi
  if [[ -z "$CT_ID" || ! "$CT_ID" =~ ^[0-9]+$ ]]; then
    # Repli : max des IDs LXC+VM existants + 1 (minimum 100)
    CT_MAX="$({ pct list; qm list; } 2>/dev/null | awk '$1 ~ /^[0-9]+$/ {if ($1+0 > m) m=$1+0} END {print m+1}')"
    CT_ID="$(( ${CT_MAX:-1} ))"
    [[ "$CT_ID" -lt 100 ]] && CT_ID=100
  fi
  msg_ok "ID automatique sélectionné : $CT_ID"
fi
if pct config "$CT_ID" >/dev/null 2>&1; then msg_error "Conteneur $CT_ID existe déjà."; exit 1; fi

# Mot de passe root du conteneur
if [[ -z "$CT_PW" ]]; then
  CT_PW="$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)"
  GEN_PW=1
fi

# ───────────────────────────────────────────────────────────────────
#  1d. Saisie interactive des identifiants Home Assistant
# ───────────────────────────────────────────────────────────────────
# Si HA_TOKEN n'est pas fourni (env) ET que stdin est un terminal,
# on le demande à l'installation. En mode non-interactif (pipe/CI),
# on passe et l'utilisateur renseignera ensuite.
if [[ -z "$HA_TOKEN" && -t 0 ]]; then
  echo ""
  msg_info "Configuration Home Assistant"
  msg_info "   Laisse vide pour continuer sans (à renseigner ensuite dans /etc/energie-dashboard.env)."
  read -r -p "  Token d'accès long HA : " _t
  HA_TOKEN="${_t//[[:space:]]/}"                     # retire espaces/sauts (collage)
  read -r -p "  URL de HA [${HA_URL:-http://192.168.40.214:8123}] : " _u
  [[ -n "$_u" ]] && HA_URL="$_u"
  if [[ -n "$HA_TOKEN" ]]; then
    msg_ok "Home Assistant configuré (URL=$HA_URL)."
  fi
fi

# ───────────────────────────────────────────────────────────────────
#  2. Template OS (téléchargement si absent)
# ───────────────────────────────────────────────────────────────────
# Résolution automatique : si CT_TEMPLATE est 'auto' (ou vide), on détecte
# la dernière version Debian disponible sur le dépôt (le nom fixe devient
# obsolète : échec "template: no such template").
if [[ -z "$CT_TEMPLATE" || "$CT_TEMPLATE" == "auto" ]]; then
  msg_info "Recherche de la dernière template Debian ${CT_VER}..."
  pveam update >/dev/null 2>&1 || true
  CT_TEMPLATE="$(pveam available 2>/dev/null \
    | grep -oP "debian-${CT_VER}-standard_[0-9.]+-[0-9]+_amd64\.tar\.zst" \
    | head -1)"
  if [[ -z "$CT_TEMPLATE" ]]; then
    msg_error "Aucune template Debian $CT_VER trouvée (pveam available vide)."
    msg_error "Précise-la : CT_TEMPLATE=debian-12-standard_XX.Y-Z_amd64.tar.zst bash install_lxc.sh"
    exit 1
  fi
  msg_info "Template retenue : $CT_TEMPLATE"
fi

msg_info "Vérification du template $CT_TEMPLATE..."
if ! pveam list "$CT_TEMPLATE_STORE" | grep -q "$CT_TEMPLATE"; then
  msg_info "Téléchargement du template..."
  pveam download "$CT_TEMPLATE_STORE" "$CT_TEMPLATE" || { msg_error "Téléchargement template échoué."; exit 1; }
fi
msg_ok "Template prêt."

# ───────────────────────────────────────────────────────────────────
#  3. Création du LXC
# ───────────────────────────────────────────────────────────────────
msg_info "Création du LXC '$CT_NAME' (id=$CT_ID)..."
pct create "$CT_ID" \
  "$CT_TEMPLATE_STORE:vztmpl/$CT_TEMPLATE" \
  --hostname "$CT_NAME" \
  --ostype "$CT_OS" \
  --password "$CT_PW" \
  --cores "$CT_CORES" \
  --memory "$CT_RAM" \
  --swap "$CT_SWAP" \
  --rootfs "$CT_STORAGE:$CT_DISK" \
  --net0 "name=eth0,bridge=$CT_BRIDGE,ip=dhcp,firewall=0" \
  --features nesting=1 \
  --unprivileged 1 \
  --onboot 1 \
  --description "conso-maison — dashboard conso énergie depuis Home Assistant (LXC)" \
  >/dev/null
msg_ok "LXC créé."

pct start "$CT_ID"
msg_info "Attente du réseau dans le conteneur..."
for i in $(seq 1 30); do
  pct exec "$CT_ID" -- ping -c1 -W1 8.8.8.8 >/dev/null 2>&1 && break
  sleep 2
done
msg_ok "LXC démarré et joignable."

# ───────────────────────────────────────────────────────────────────
#  4. Installation de la stack (Node 20 + outils + repo + service)
# ───────────────────────────────────────────────────────────────────
msg_info "Installation de la stack (peut prendre plusieurs minutes)..."
pct exec "$CT_ID" -- bash -s <<'INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# DNS de secours
grep -q nameserver /etc/resolv.conf || echo "nameserver 1.1.1.1" > /etc/resolv.conf
apt-get update -y
apt-get install -y --no-install-recommends curl ca-certificates gnupg git \
    python3 make g++ sqlite3 build-essential
# Node.js 20 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version && npm --version
INNER
msg_ok "Node.js installé."

# ───────────────────────────────────────────────────────────────────
#  5. Code + utilisateur + dépendances
# ───────────────────────────────────────────────────────────────────
SERVICE_USER="$SERVICE_USER" REPO_DIR="$REPO_DIR" REPO_URL="$REPO_URL" \
pct exec "$CT_ID" -- bash -s <<'INNER'
set -euo pipefail
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$REPO_DIR"
git clone --depth 1 "$REPO_URL" "$REPO_DIR" 2>/dev/null || true
cd "$REPO_DIR"
npm ci --omit=dev || npm install --omit=dev
mkdir -p /data
chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR" /data
INNER
msg_ok "Code déployé et dépendances installées."

# ───────────────────────────────────────────────────────────────────
#  6. Configuration (.env + env système)
# ───────────────────────────────────────────────────────────────────
HA_URL="$HA_URL" HA_TOKEN="$HA_TOKEN" DB_PATH="$DB_PATH" \
POLL_INTERVAL_MS="$POLL_INTERVAL_MS" RETENTION_DAYS="$RETENTION_DAYS" \
SERVICE_USER="$SERVICE_USER" REPO_DIR="$REPO_DIR" \
pct exec "$CT_ID" -- bash -s <<'INNER'
set -euo pipefail
printf 'HA_URL=%s\nHA_TOKEN=%s\nWEATHER_ENTITY=weather.pirateweather\n' \
  "$HA_URL" "$HA_TOKEN" > "$REPO_DIR/.env"
chown "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR/.env"
chmod 600 "$REPO_DIR/.env"
printf 'DB_PATH=%s\nPOLL_INTERVAL_MS=%s\nRETENTION_DAYS=%s\n' \
  "$DB_PATH" "$POLL_INTERVAL_MS" "$RETENTION_DAYS" > /etc/energie-dashboard.env
# ⚠️ Les identifiants HA DOIVENT être dans l'EnvironmentFile : le .env n'est
# pas lu par Node (pas de dotenv) et le service lit process.env via systemd.
printf 'HA_URL=%s\nHA_TOKEN=%s\nWEATHER_ENTITY=weather.pirateweather\n' \
  "$HA_URL" "$HA_TOKEN" >> /etc/energie-dashboard.env
chmod 600 /etc/energie-dashboard.env
INNER
msg_ok "Configuration écrite."

# ───────────────────────────────────────────────────────────────────
#  7. Service systemd
# ───────────────────────────────────────────────────────────────────
SERVICE_NAME="$SERVICE_NAME" SERVICE_USER="$SERVICE_USER" REPO_DIR="$REPO_DIR" DB_PATH="$DB_PATH" \
pct exec "$CT_ID" -- bash -s <<'INNER'
set -euo pipefail
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=Energie Dashboard (conso maison depuis Home Assistant)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=/etc/energie-dashboard.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/data $REPO_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
INNER
msg_ok "Service systemd installé."

# ───────────────────────────────────────────────────────────────────
#  8. (Option) Migration de la DB depuis le volume Docker
# ───────────────────────────────────────────────────────────────────
if [[ "$MIGRATE" == "1" && -f "$DOCKER_VOL/energie.db" ]]; then
  msg_info "Migration de la base SQLite depuis Docker..."
  tar -C "$(dirname "$DOCKER_VOL")" -cf - "$(basename "$DOCKER_VOL")/energie.db" \
    | pct exec "$CT_ID" -- tar -C /data -xf -
  pct exec "$CT_ID" -- chown "$SERVICE_USER:$SERVICE_USER" /data/energie.db
  msg_ok "Base migrée (historique conservé)."
elif [[ "$MIGRATE" == "1" ]]; then
  msg_info "Volume Docker '$DOCKER_VOL/energie.db' introuvable — départ à zéro."
fi

# ───────────────────────────────────────────────────────────────────
#  9. Démarrage + vérification
# ───────────────────────────────────────────────────────────────────
SERVICE_NAME="$SERVICE_NAME" pct exec "$CT_ID" -- bash -s <<'INNER'
set -euo pipefail
systemctl start "$SERVICE_NAME"
sleep 5
systemctl --no-pager --lines=15 status "$SERVICE_NAME" || true
INNER

# Récupère l'IP attribuée par DHCP dans le conteneur
CT_IP=$(pct exec "$CT_ID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
[ -z "$CT_IP" ] && CT_IP="(à récupérer via 'pct exec $CT_ID -- hostname -I')"
echo ""
echo "══════════════════════════════════════════════════════════════"
echo " ✅ Installation terminée !"
echo "══════════════════════════════════════════════════════════════"
echo "  Conteneur : $CT_NAME  (id=$CT_ID)"
echo "  IP (DHCP) : $CT_IP"
echo "  Dashboard : http://$CT_IP:$PORT"
echo "  (fini le fixe — l'adresse est attribuée par le serveur DHCP)"
echo ""
echo "  Gestion :"
echo "    pct exec $CT_ID -- systemctl restart $SERVICE_NAME"
echo "    pct exec $CT_ID -- journalctl -u $SERVICE_NAME -f"
if [[ "${GEN_PW:-0}" == "1" ]]; then
  echo ""
  echo "  ⚠️  Mot de passe root du conteneur (généré) : $CT_PW"
  echo "      (change-le : pct exec $CT_ID -- passwd)"
fi
if [[ -z "$HA_TOKEN" ]]; then
  echo ""
  echo "  ⚠️  HA_TOKEN vide. Renseigne-le dans /etc/energie-dashboard.env :"
  echo "    pct exec $CT_ID -- sed -i \"s|^HA_TOKEN=.*|HA_TOKEN=<TON_TOKEN>|\" /etc/energie-dashboard.env"
  echo "    pct exec $CT_ID -- systemctl restart $SERVICE_NAME"
fi
if [[ -n "$HA_TOKEN" ]]; then
  echo ""
  echo "  🔒 Home Assistant configuré (token stocké en root, chmod 600)."
  echo "     Ne le commit jamais ; il ne vit que dans /etc/energie-dashboard.env."
fi
echo "══════════════════════════════════════════════════════════════"