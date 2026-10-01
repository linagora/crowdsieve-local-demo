# Export Crowdsieve pour les étudiants

Outils pour extraire la base PostgreSQL de [Crowdsieve](https://github.com/linagora/crowdsieve)
déployée sur Kubernetes, la convertir en base SQLite, et faire tourner un
Crowdsieve local sur ces données.

Les alertes **BAD_CREDENTIALS de LemonLDAP::NG** sont retirées à l'export,
ainsi que leurs décisions et leurs événements.

## Contenu

| Fichier              | Rôle                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `export.sh`          | Pilote l'export depuis ce PC (kubectl cp, exec, rapatriement)        |
| `extract.mjs`        | Exécuté **dans le pod** : lit PostgreSQL, écrit le fichier SQLite    |
| `docker-compose.yml` | Lance Crowdsieve sur une base SQLite locale                          |
| `crowdsieve.yaml`    | Configuration Crowdsieve adaptée à un jeu de données figé            |
| `.env.example`       | Variables du docker-compose                                          |

## 1. Exporter les données

Prérequis : `kubectl` avec accès au contexte `prod-hosting`, `sha256sum`,
`gunzip` ; `sqlite3` est optionnel (contrôle d'intégrité).

```bash
./export.sh --inspect        # aperçu : comptes par scénario et alertes qui seront exclues
./export.sh etudiants.db     # export (par défaut : crowdsieve-AAAAMMJJ.db)
```

Déroulement :

1. choix d'un pod `crowdsieve` en cours d'exécution (les pods `crowdsieve-lapi` sont ignorés) ;
2. `kubectl cp` de `extract.mjs` dans `/tmp` du pod, à chaque lancement (le pod a pu redémarrer) ;
3. extraction dans le pod : il utilise les variables `POSTGRES_*`, `pg` et
   `better-sqlite3` de l'image, donc aucun identifiant ne transite par ce PC.
   La lecture se fait dans un seul instantané `REPEATABLE READ READ ONLY` ;
4. compression, rapatriement par `kubectl cp`, vérification sha256 et `PRAGMA integrity_check` ;
5. suppression du répertoire temporaire dans le pod, y compris en cas d'erreur.

La base produite a exactement le schéma SQLite de Crowdsieve, et les `id` sont
conservés : les relations alertes / décisions / événements restent valides.

### Options

| Option                  | Défaut          | Description                                              |
| ----------------------- | --------------- | -------------------------------------------------------- |
| `--context CTX`         | `prod-hosting`  | Contexte kubectl                                         |
| `-n`, `--namespace NS`  | `crowdsieve`    | Namespace                                                |
| `--pod POD`             | auto            | Pod à utiliser                                           |
| `--exclude-where SQL`   | LLNG BAD_CREDENTIALS | Condition PostgreSQL (alias `a` = `alerts`) des alertes à retirer |
| `--no-exclude`          |                 | Tout garder                                              |
| `--inspect`             |                 | Afficher ce qui serait exclu, sans rien écrire           |
| `--force`               |                 | Écraser le fichier de sortie                             |

Le filtre par défaut retire les alertes qui mentionnent `lemon`/`llng` **et**
`bad_credential` (`BAD_CREDENTIALS`, `bad-credentials`…) dans le scénario, le
message, le `machine_id` ou le `raw_json`. Vérifiez-le avec `--inspect`.

Exemple de filtre personnalisé :

```bash
./export.sh --exclude-where "a.scenario = 'llng/BAD_CREDENTIALS'" etudiants.db
```

L'export est d'abord écrit dans le `/tmp` du pod : il faut assez de stockage
éphémère pour la base SQLite et sa version compressée.

## 2. Lancer Crowdsieve sur les données

```bash
CROWDSIEVE_DB=./etudiants.db docker compose up -d
```

ou bien `cp .env.example .env`, l'adapter, puis `docker compose up -d`.

- Dashboard : <http://localhost:3000> (sans authentification)
- API : <http://localhost:8080>, avec l'en-tête `X-API-Key: crowdsieve-students`

```bash
curl -H 'X-API-Key: crowdsieve-students' http://localhost:8080/api/stats
```

Arrêt : `CROWDSIEVE_DB=./etudiants.db docker compose down -v`

### Fonctionnement

- Le fichier SQLite est monté **en lecture seule** puis copié dans un volume de
  travail à chaque démarrage : l'original n'est jamais modifié, et un
  redémarrage remet les données d'origine.
- Il doit être lisible par l'utilisateur du conteneur (uid 1001) : `chmod 644 etudiants.db`.
- La rétention est fixée à 100 ans (pas de purge des données anciennes).
- Aucun transfert vers la CAPI CrowdSec, pas d'analyzers, pas de LAPI.

### Variables

| Variable             | Défaut                | Description                                  |
| -------------------- | --------------------- | -------------------------------------------- |
| `CROWDSIEVE_DB`      | (obligatoire)         | Fichier SQLite à servir                      |
| `CROWDSIEVE_VERSION` | `0.6.6`               | Tag de l'image `yadd/crowdsieve`             |
| `BIND_ADDRESS`       | `127.0.0.1`           | Adresse d'écoute (`0.0.0.0` pour le réseau)  |
| `DASHBOARD_PORT`     | `3000`                | Port du dashboard                            |
| `PROXY_PORT`         | `8080`                | Port de l'API                                |
| `DASHBOARD_API_KEY`  | `crowdsieve-students` | Clé API partagée par le dashboard et l'API   |

### Limites

- Pas de ban / déban depuis le dashboard (aucun LAPI configuré).
- Pas de base GeoIP : inutile, l'enrichissement géographique est déjà stocké dans les alertes.
- Les vues limitées aux dernières heures ou aux derniers jours sont vides, puisque les données sont figées.

## Données sensibles

Seules les alertes LLNG BAD_CREDENTIALS sont retirées. Avant de distribuer une
base, pensez aux champs suivants :

- `validated_clients.token_hash` : empreintes des jetons des machines ;
- `alerts.actor` : identité des administrateurs ayant banni ou débanni ;
- `analyzer_runs.results_json` : peut contenir des noms d'utilisateurs ;
- adresses IP et `raw_json` des alertes.

Les fichiers de données (`*.db`, `*.gz`…) et `.env` sont exclus de git par le `.gitignore`.
