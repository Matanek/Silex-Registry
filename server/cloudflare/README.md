# Témoin Cloudflare de Task-09

Ce Worker expérimental met à l'épreuve le protocole `/v2` du candidat Silex avec
D1 pour les sessions et versions, et R2 pour les segments puis objets canoniques.
Il n'est pas le registre public : son jeton unique de banc, ses contrôles
d'admission et sa limite de 8 Mio par objet ne conviennent pas à la production.

Le stockage local est celui de Wrangler. Depuis ce dossier :

```sh
npm ci
./node_modules/.bin/wrangler d1 migrations apply silex-registry-staging --local
```

Créer `.dev.vars` avec `STAGING_TOKEN_SHA256`, empreinte SHA-256 d'un jeton de
64 caractères hexadécimaux propre au banc. `PROBE_ALLOW_FAULTS=1` active
localement les points d'interruption authentifiés. Puis lancer le Worker :

```sh
./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8791
PROBE_ORIGIN=http://127.0.0.1:8791 PROBE_TOKEN=<jeton> PROBE_TEST_FAULTS=1 npm test
PROBE_ORIGIN=http://127.0.0.1:8791 PROBE_TOKEN=<jeton> node tests/cli-local.mjs
```

Le test CLI emploie le binaire candidat du worktree Silex, un magasin auteur et
un magasin consommateur distincts, publie deux versions et exécute du code
installé depuis le Worker. Il doit être lancé depuis ce dossier ; le binaire
Silex compile la source du consommateur depuis la racine du groupe `Worktree`.

`wrangler.remote.toml` utilise un Worker local avec bindings sur les ressources
réelles `silex-registry-staging`. Toute écriture via cette configuration modifie
le staging Cloudflare. Les scénarios distants exigent un accord explicite pour
leurs fixtures et leur nettoyage. Utiliser un `PROBE_RUN_ID` alphanumérique
unique commun à `npm test`, `cli-local.mjs` et `cleanup-remote.mjs` ; le dernier
produit d'abord un plan et un reçu, puis `--apply` supprime les seuls noms de ce
run. `PROBE_STORAGE=local` permet de répéter le nettoyage contre l'émulation.
Le reçu persiste pour reprendre un nettoyage interrompu.

La preuve durable dépend d'un test sur D1/R2 réels. Une réponse locale verte ne
qualifie ni les limites de calcul, ni les quotas, ni les coûts Cloudflare.
