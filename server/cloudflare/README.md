# Témoin Cloudflare de Task-09 et parcours auteur de Task-10

Ce Worker expérimental met à l'épreuve le protocole `/v2` du candidat Silex avec
D1 pour les sessions et versions, et R2 pour les segments puis objets canoniques.
Il n'est pas le registre public : son jeton unique de banc et ses tables
`probe_*` sont propres aux essais. L'admission borne les sources compressées à
32 Mio, leur contenu à 48 Mio et chaque artefact distinct à 64 Mio.

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
installé depuis le Worker. La première fixture n’a pas de dépôt Git ; la
deuxième déclare un lien de développement facultatif, sans qu’il soit utilisé
comme source des octets publiés. Il doit être lancé
depuis ce dossier ; le binaire Silex compile la source du consommateur depuis
la racine du groupe `Worktree`.

`tests/login-fixture-worker.mjs` est une entrée distincte, réservée aux tests
locaux avec fournisseur GitHub simulé. Elle n'est pas le Worker déployé.
`LOGIN_FIXTURE_ORIGIN` active ses scénarios de ticket, concurrence, refus,
expiration, révocation et propriété des noms. Le Worker déployé utilise le flux
GitHub réel ; `LOGIN_KEY_B64` reste un secret Wrangler. L’identité GitHub
autorise l’auteur et les droits sur le nom. `Package.json.repository` peut
indiquer une adresse GitHub à destination des contributeurs ; ce lien facultatif
n’est pas vérifié, n’accorde aucun droit et ne sert pas à reconstituer la publication.

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

Avant tout import historique, `admin/validate-bundle.mjs BUNDLE PLAN OWNERS`
contrôle en lecture seule l'ordre des 155 versions, les preuves de propriété,
les dépendances, les 171 objets par taille et SHA-256, et les archives source.
Le lot préparé dans la Spec comporte 30 noms : `GFX.Nodes` a un propriétaire
réservé mais aucune version importable. `GFX.Audio@0.4.0` reste explicitement
absente faute de deux artefacts historiques.

`admin/import-bundle.mjs BUNDLE PLAN OWNERS --local|--remote DATABASE BUCKET CONFIG`
reprend ce contrôle avant tout transfert, vérifie les objets R2 déjà présents,
place les objets manquants puis insère noms et versions avec `INSERT OR IGNORE`.
Il refuse un nom, une version ou un objet préexistant divergent et vérifie les
lignes D1 finales. En mode distant, définir `REGISTRY_ADMIN_ORIGIN` sur l'origine
du Worker lié à la destination et `REGISTRY_MAINTENANCE_TOKEN` sur son jeton
administratif de 64 caractères hexadécimaux. Le Worker vérifie le SHA-256 en
écrivant chaque objet R2 ; un upload direct avec `wrangler r2 object put` ne
fournit pas ce checksum et n'est pas lisible par le registre. Appliquer d'abord
les migrations D1 sur la destination.
`node tests/import-local.mjs` exerce deux imports d'un sous-lot historique dans
un état Wrangler temporaire et vérifie le refus d'un objet altéré.

`admin/export-store.mjs --local|--remote DATABASE BUCKET CONFIG DESTINATION`
copie les lignes publiques D1 et chaque objet R2 référencé vers un nouveau
dossier. Chaque taille, SHA-256 et archive source est vérifié ; l'export échoue
si les métadonnées D1 changent entre le début et la fin. La copie n'inclut ni
jeton, ni clé de connexion, ni session d'upload. La destination prévue pour les
copies réelles est `SilexProject/Backups/Silex-Registry`.

`admin/restore-backup.mjs BACKUP --local|--remote DATABASE BUCKET CONFIG`
revérifie la copie puis restaure vers une base D1 vide. Employer une base et un
bucket R2 distincts du service source. Le test local restaure la copie dans un
second état Wrangler isolé et refuse une nouvelle restauration vers cet état
déjà rempli.

Une session de publication reste reprenable pendant sept jours depuis sa
création. Après huit jours, `admin/prune-sessions.mjs ORIGIN --local|--remote
DATABASE BUCKET CONFIG --plan|--apply` retire ses fragments R2 puis ses lignes
D1 ; le délai d'un jour protège une requête déjà en cours au moment de
l'expiration. Le script exige `REGISTRY_MAINTENANCE_TOKEN`. Il peut être relancé
après une interruption : la session D1 est supprimée seulement après ses
fragments. Les objets canoniques publiés ne sont jamais visés par cette purge.
