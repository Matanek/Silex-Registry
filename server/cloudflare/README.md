# Témoin Cloudflare de Task-09 et parcours auteur de Task-10

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
64 caractères hexadécimaux propre au banc, et `LOGIN_KEY_B64`, clé aléatoire
de 32 octets encodée en base64. Le Client ID GitHub public est dans les fichiers
Wrangler. `PROBE_ALLOW_FAULTS=1` active localement les points d'interruption
authentifiés. Puis lancer le Worker :

```sh
./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8791
PROBE_ORIGIN=http://127.0.0.1:8791 PROBE_TOKEN=<jeton> PROBE_TEST_FAULTS=1 npm test
PROBE_ORIGIN=http://127.0.0.1:8791 PROBE_TOKEN=<jeton> node tests/cli-local.mjs
```

Le test CLI emploie le binaire candidat du worktree Silex, un magasin auteur et
un magasin consommateur distincts, publie deux versions et exécute du code
installé depuis le Worker. Chaque fixture possède un dépôt Git local et une
origine GitHub ; la deuxième version publie un instantané local différent de
`HEAD`, tout en enregistrant ce commit comme provenance. Il doit être lancé
depuis ce dossier ; le binaire Silex compile la source du consommateur depuis
la racine du groupe `Worktree`.

`tests/login-fixture-worker.mjs` est une entrée distincte, réservée aux tests
locaux avec fournisseur GitHub simulé. Elle n'est pas le Worker déployé.
`LOGIN_FIXTURE_ORIGIN` active ses scénarios de ticket, concurrence, refus,
expiration, révocation et propriété des noms. Le Worker déployé utilise le flux
GitHub réel ; `LOGIN_KEY_B64` reste un secret Wrangler. La provenance exige un
dépôt GitHub public possédé par l'identité stable connectée ; le commit local
est enregistré sans comparaison avec les octets de l'instantané. Les routes
d'auteur n'acceptent pas une simple URL comme preuve de propriété.

`wrangler.remote.toml` utilise un Worker local avec bindings sur les ressources
réelles `silex-registry-staging`. Toute écriture via cette configuration modifie
le staging Cloudflare. Les scénarios distants exigent un accord explicite pour
leurs fixtures et leur nettoyage. Utiliser un `PROBE_RUN_ID` alphanumérique
unique commun à `npm test`, `cli-local.mjs` et `cleanup-remote.mjs` ; le dernier
produit d'abord un plan et un reçu, puis `--apply` supprime les seuls noms de ce
run. `PROBE_STORAGE=local` permet de répéter le nettoyage contre l'émulation.
Le reçu persiste pour reprendre un nettoyage interrompu.

Le Worker de staging autorisé est sur
`https://silex-registry-staging-probe.silex-lang.workers.dev`. Le CLI candidat
refuse une origine de test HTTPS : `tests/edge-proxy.mjs` relaie seulement les
requêtes de qualification depuis `127.0.0.1:8793` vers ce Worker. Démarrer ce
relais avec `PROBE_UPSTREAM` fixé exactement à cette URL ; employer ensuite
`PROBE_ORIGIN=http://127.0.0.1:8793` pour le test CLI. Le relais n'est pas un
composant du registre et ne doit pas être utilisé comme origine produit.

Une réponse locale ou un essai de staging vert ne qualifie ni les gros objets,
ni les quotas, ni les coûts Cloudflare pour le registre complet.
