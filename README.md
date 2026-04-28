# fursat-ws-detector

WebSocket-based crypto pump detector for the [fursat.net](https://fursat.net) agent.

## Status: Étape 1 — connexion WS + health check

À ce stade, le worker se contente de :
- Découvrir les produits `*-USDC` tradables sur Coinbase Advanced (REST)
- Se connecter au channel public `ticker` en WebSocket
- Recevoir les ticks et les compter
- Exposer `/health` et `/metrics` pour Railway et cron-job.org
- Écrire un heartbeat throttlé dans Redis (`dryrun:ws_heartbeat`)

Pas encore de ring buffers, pas de détection, pas de trader fictif. Cf. roadmap dans la conversation source.

## Setup local

```bash
# Pré-requis : Node.js 20+
npm install

# Copie le template d'env
cp .env.example .env
# Édite .env et renseigne UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
# (mêmes valeurs que fursat.net — le worker écrit uniquement sur dryrun:*)

# Lance en dev (rebuild auto)
npm run dev

# Ou build + run
npm run build
npm run start
```

Le worker écoute par défaut sur `http://localhost:8080`. Vérifie :

```bash
curl http://localhost:8080/health
curl http://localhost:8080/metrics
```

`/health` retourne `200` une fois que le WS a reçu son premier tick (≤ ~5s après le démarrage). Avant, il retourne `503`.

## Déploiement Railway

1. Sur railway.app → "New Project" → "Deploy from GitHub repo" → choisis `fursat-ws-detector`
2. Dans **Settings → Variables**, ajoute :
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `LOG_LEVEL=info` (ou `debug` pour les premiers jours)
3. Railway build automatiquement (Nixpacks détecte Node.js + `npm run start`)
4. Settings → Networking → "Generate Domain" pour obtenir une URL `*.up.railway.app`
5. Healthcheck déjà configuré dans `railway.json` (`/health` avec 30s timeout)

### Surveillance externe (cron-job.org)

Crée un job qui ping `https://<railway-url>/health` toutes les 5 min :
- HTTP method: GET
- Notification: email ou SMS sur "HTTP failure" (PAS sur "timeout" pour éviter les faux positifs)

## Architecture

```
src/
├── index.ts         # Bootstrap + handlers SIGTERM
├── coinbase-ws.ts   # Connexion WS, reconnect exponentiel, watchdog heartbeat
├── products.ts      # Fetch initial + refresh des produits *-USDC tradables
├── health-server.ts # Serveur HTTP /health et /metrics
├── redis.ts         # Helper Upstash REST (namespace dryrun:* enforced)
└── logger.ts        # Logger structuré niveau-filtré
```

## Critères de succès Étape 1

- [ ] Le worker tourne 24h sans déconnexion permanente (quelques reconnexions
      transitoires sont OK et attendues — Coinbase fait tourner ses serveurs)
- [ ] `/health` retourne `200` la majorité du temps
- [ ] `ws_ticks_received_total` augmente continuellement (~1000-5000 ticks/min observés)
- [ ] `dryrun:ws_heartbeat` se met à jour toutes les 30s dans Upstash
- [ ] Aucune fuite mémoire (RSS stable sur Railway dashboard)

## Roadmap

- **Étape 2** : ring buffers 5m/15m/1h, intégration `signal-rules.ts` partagée avec fursat.net
- **Étape 3** : détection event-driven sur tick, log des signaux dans `dryrun:signals_log`
- **Étape 4** : trader fictif + fast-exit rules + slippage simulé (0.1%) + frais (0.45%)
- **Étape 5** : dashboard `/dry-run` sur fursat.net (lecture seule des clés `dryrun:*`)
- **Étape 6** : observation 3-7 jours, mesure de l'edge vs prod, décision go/no-go trading réel
