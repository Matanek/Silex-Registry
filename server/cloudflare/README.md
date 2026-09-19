# Registre Silex sur Cloudflare

Le registre public utilise un Worker Cloudflare, D1 pour les sessions et
versions, et R2 pour les segments puis objets canoniques. Les tables conservent
leur préfixe historique `probe_*`. L'admission borne les sources compressées à
32 Mio, leur contenu à 48 Mio et chaque artefact distinct à 64 Mio.

Les configurations réelles Wrangler sont locales et ignorées par Git. Copier
`wrangler.staging.example.toml` vers `wrangler.toml`, renseigner ses variables,
puis, depuis ce dossier :

```sh
npm ci
./node_modules/.bin/wrangler d1 migrations apply silex-registry-staging --local
```

Créer `.dev.vars` avec `STAGING_TOKEN_SHA256`, empreinte SHA-256 d'un jeton de
64 caractères hexadécimaux propre au banc, et `LOGIN_KEY_B64`, clé aléatoire
de 32 octets encodée en base64. Renseigner aussi le Client ID public de
l'application GitHub dans la configuration locale. `PROBE_ALLOW_FAULTS=1`
active localement les points d'interruption
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

Une configuration distante locale peut relier Wrangler à un banc Cloudflare
isolé. Elle ne doit jamais être committée : identifiants du compte, D1, R2,
Queues et B2 restent hors du dépôt. Les scénarios distants exigent un accord
explicite pour leurs fixtures et leur nettoyage. Utiliser un `PROBE_RUN_ID`
alphanumérique unique commun à `npm test`, `cli-local.mjs` et
`cleanup-remote.mjs` ; le dernier produit d'abord un plan et un reçu, puis
`--apply` supprime les seuls noms de ce run.

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
jeton, ni clé de connexion, ni session d'upload. Cet export manuel sert à un
diagnostic ou à une migration ponctuelle ; la sauvegarde d'exploitation est
la copie B2 décrite ci-dessous.

`admin/restore-backup.mjs BACKUP --local|--remote DATABASE BUCKET CONFIG`
revérifie la copie puis restaure vers une base D1 vide. Employer une base et un
bucket R2 distincts du service source. Le test local restaure la copie dans un
second état Wrangler isolé et refuse une nouvelle restauration vers cet état
déjà rempli.

La continuité courante utilise Backblaze B2 plutôt que le disque d'une machine.
La production envoie par Cloudflare Queue les objets SHA-256, les publications
et les instantanés de métadonnées sous `registry/production`. Les écritures B2
sont chiffrées, contrôlées par checksum et protégées 90 jours par Object Lock.
Le volume logique accepté est borné à 8 Gio. Le staging a servi à la
qualification complète, puis `BACKUP_REQUIRED=0` y a arrêté les nouvelles
copies.

`admin/restore-b2.mjs --local|--remote DATABASE BUCKET CONFIG` télécharge le
dernier instantané du préfixe indiqué par `B2_PREFIX`, vérifie tous les objets
et archives, puis exige une destination vide. Les identifiants B2, l'origine du
Worker de destination et son jeton administratif sont fournis par variables
d'environnement et ne sont jamais écrits dans Git.

Une session de publication reste reprenable pendant sept jours depuis sa
création. Après huit jours, `admin/prune-sessions.mjs ORIGIN --local|--remote
DATABASE BUCKET CONFIG --plan|--apply` retire ses fragments R2 puis ses lignes
D1 ; le délai d'un jour protège une requête déjà en cours au moment de
l'expiration. Le script exige `REGISTRY_MAINTENANCE_TOKEN`. Il peut être relancé
après une interruption : la session D1 est supprimée seulement après ses
fragments. Les objets canoniques publiés ne sont jamais visés par cette purge.

La [procédure d'exploitation](OPERATIONS.md) décrit le déploiement, les copies,
les alertes et le retour arrière.

Le Worker de production porte le cron quotidien de purge des sessions et de
création d'instantané B2. `admin/run-maintenance.mjs` reste un outil manuel de
diagnostic et de copie locale ; il ne doit pas être planifié sur un Mac ou une
machine d'administrateur.
