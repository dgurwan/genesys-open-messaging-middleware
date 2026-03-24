# Genesys ↔ Sinch RCS Middleware

Bridge Node.js complet pour ce flux :

1. **End user RCS** envoie un message à **Sinch Conversation API**.
2. **Sinch** appelle `POST /webhooks/sinch` sur ce middleware.
3. Le middleware transforme le message au format **Genesys Cloud Open Messaging inbound**.
4. **Genesys Cloud** route la conversation vers un agent via l'intégration Open Messaging.
5. Quand l'agent répond, **Genesys** appelle `POST /webhooks/genesys/outbound`.
6. Le middleware transforme le message sortant Genesys vers **Sinch Conversation API** pour **RCS**.
7. Les **receipts Sinch** sont renvoyés vers **Genesys inbound receipt**.

## Fonctionnalités incluses

- `POST /api/messages` pour injecter un message test ou custom vers Genesys
- `POST /webhooks/sinch` pour recevoir les callbacks Sinch
- `POST /webhooks/genesys/outbound` pour recevoir les réponses agent Genesys
- `GET /api/conversations` pour voir les conversations en mémoire
- `GET /api/conversations/:externalUserId/messages` pour relire l'historique
- `GET /api/conversations/:externalUserId/events` en SSE pour suivre les événements
- OAuth2 **Client Credentials** vers Genesys Cloud
- OAuth2 **Client Credentials** vers Sinch
- validation webhook **Genesys** avec `X-Hub-Signature-256`
- validation webhook **Sinch** avec `x-sinch-webhook-signature`
- déduplication simple des retries webhook
- mapping des receipts **Sinch -> Genesys**

## Ce que cette version mappe déjà

### Sinch RCS -> Genesys

- texte inbound
- média inbound
- localisation inbound, convertie en texte
- quick reply inbound, convertie en texte avec metadata

### Genesys -> Sinch RCS

- texte agent -> `text_message`
- média agent -> `media_message`
- quick replies simples -> `choice_message`
- cartes simples -> `card_message`
- carrousels simples -> `carousel_message`

## Limitations connues

- stockage **en mémoire** uniquement
- pas de base SQL / Redis
- les quick replies RCS inbound sont relayées en texte + metadata côté Genesys
- le format exact des templates riches Genesys peut varier selon le payload normalisé reçu par ton org ; le mapper gère les formes les plus fréquentes, mais peut nécessiter un ajustement léger après capture de vrais payloads
- si Genesys rejette un inbound média avec `content[].attachment`, le middleware retombe automatiquement en **texte + URL média**

## Pré-requis Genesys Cloud

1. créer un client OAuth **Client Credentials**
2. lui donner les permissions nécessaires à Open Messaging
3. créer une **Open Messaging integration**
4. configurer son **Outbound Notification Webhook URL** vers :

```text
https://<ton-domaine>/webhooks/genesys/outbound
```

5. configurer son **secret webhook**
6. rattacher l'intégration à un **Inbound Message Flow** dans Architect

## Pré-requis Sinch

1. disposer d'un **project** Sinch avec une **Conversation API app**
2. disposer d'un **RCS Sender Agent** rattaché à cette app
3. créer une **access key** Sinch pour OAuth2
4. créer un webhook Sinch vers :

```text
https://<ton-domaine>/webhooks/sinch
```

5. renseigner un **secret** webhook Sinch
6. activer au minimum les triggers :
   - `MESSAGE_INBOUND`
   - `MESSAGE_DELIVERY`

## Installation

```bash
npm install
cp .env.example .env
```

## Variables d'environnement

```env
PORT=3000
TRUST_PROXY=false
MAX_MESSAGES_PER_CONVERSATION=100

# Genesys
GENESYS_CLOUD_DOMAIN=mypurecloud.com
# ou renseigner explicitement les URLs ci-dessous
# GENESYS_CLOUD_LOGIN_BASE_URL=https://login.mypurecloud.com
# GENESYS_CLOUD_API_BASE_URL=https://api.mypurecloud.com
GENESYS_CLOUD_CLIENT_ID=your_genesys_client_id
GENESYS_CLOUD_CLIENT_SECRET=your_genesys_client_secret
GENESYS_OPEN_MESSAGING_INTEGRATION_ID=your_open_messaging_integration_id
GENESYS_OUTBOUND_WEBHOOK_SECRET=your_genesys_webhook_secret
GENESYS_PREFETCH_CONVERSATION_ID=false
GENESYS_INCLUDE_ATTACHMENT_CONTENT=true
GENESYS_MAX_MESSAGE_BYTES=131072

# Sinch
SINCH_REGION=eu
# ou renseigner explicitement : SINCH_CONVERSATION_BASE_URL=https://eu.conversation.api.sinch.com
SINCH_PROJECT_ID=your_sinch_project_id
SINCH_APP_ID=your_sinch_app_id
SINCH_KEY_ID=your_sinch_key_id
SINCH_KEY_SECRET=your_sinch_key_secret
SINCH_WEBHOOK_SECRET=your_sinch_webhook_secret
SINCH_SIGNATURE_MAX_SKEW_SECONDS=300
```

## Lancement

```bash
npm start
```

Le serveur écoute par défaut sur `http://localhost:3000`.

## Endpoint 1 - test / injection manuelle

### `POST /api/messages`

Exemple texte :

```bash
curl -X POST http://localhost:3000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "externalUserId": "33612345678",
    "nickname": "Jean Dupont",
    "text": "Bonjour, j ai besoin d aide",
    "metadata": {
      "sourceChannel": "manual-test"
    }
  }'
```

Exemple média :

```bash
curl -X POST http://localhost:3000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "externalUserId": "33612345678",
    "text": "Voici un justificatif",
    "mediaUrl": "https://example.com/file.pdf",
    "metadata": {
      "sourceChannel": "manual-test"
    }
  }'
```

## Endpoint 2 - callback Sinch

### `POST /webhooks/sinch`

Le middleware attend un callback signé Sinch. Il :

- valide la signature HMAC
- détecte `message` ou `message_delivery_report`
- transforme le message RCS vers Genesys inbound
- transforme les receipts Sinch vers Genesys inbound receipt

## Endpoint 3 - callback Genesys

### `POST /webhooks/genesys/outbound`

Le middleware attend un message normalisé Genesys signé. Il :

- valide `X-Hub-Signature-256`
- détecte le destinataire final RCS via `channel.to.id`
- convertit le message agent vers `text_message`, `media_message`, `choice_message`, `card_message` ou `carousel_message`
- envoie le message à Sinch Conversation API

## Endpoints de debug

### `GET /api/conversations`

Retourne les conversations connues en mémoire.

### `GET /api/conversations/:externalUserId/messages`

Retourne l'historique d'une conversation.

### `GET /api/conversations/:externalUserId/events`

SSE simple pour suivre les événements en temps réel.

## Structure du projet

```text
.
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── package.json
└── src
    ├── clients
    │   ├── genesysClient.js
    │   └── sinchClient.js
    ├── mappers
    │   ├── genesysMapper.js
    │   └── sinchMapper.js
    ├── config.js
    ├── errors.js
    ├── server.js
    ├── signatures.js
    └── validation.js
```

## Docker

Build :

```bash
docker build -t genesys-sinch-rcs-middleware .
```

Run :

```bash
docker run --rm -p 3000:3000 --env-file .env genesys-sinch-rcs-middleware
```

## Mise en production recommandée

Pour un usage réel, remplace rapidement le stockage mémoire par :

- **Redis** pour la déduplication webhook
- **PostgreSQL** pour la corrélation conversation/message
- une file d'attente pour absorber les retries
- des logs structurés centralisés
