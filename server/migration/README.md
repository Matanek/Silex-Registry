# Import administratif et restauration

Ces outils d'exploitation restent hors du document root et ne sont jamais
chargés par HTTP. Ils ne changent pas le parcours public v1. Les noms historiques
restent réservés jusqu'à leur rattachement explicite à une identité GitHub stable.

## Inventorier et récupérer

Depuis la racine du dépôt, avec Node.js, Git et curl disponibles :

```sh
node server/migration/inventory.mjs registry/v1/packages /absolute/new-inventory
node server/migration/prepare.mjs /absolute/new-inventory /absolute/bundle STD@0.22.0 GFX@0.40.0
php server/migration/verify-bundle.php /absolute/bundle
node server/migration/plan.mjs /absolute/bundle /absolute/new-plan.json
```

`inventory.mjs` refuse d'écraser un inventaire. Il observe les tags distants et
récupère leurs objets exacts dans ses seuls caches Git nus. Chaque version garde
objet de tag, commit, arbre, manifeste exact, fichiers suivis et références des
artefacts. Un checkout courant, un tag local non publié ou un export filtré par
`export-ignore` ne remplace jamais les octets historiques. Les tags sans version
canonique et les anomalies restent dans le rapport. Un nom sans tag reste inscrit
mais n'a pas de version à importer.

`prepare.mjs` peut remplacer la liste par `--all`. Il reconstruit un gzip/USTAR
déterministe des fichiers réguliers suivis, sans checkout, compilation ou exécution.
Les chemins, octets et manifeste sont conservés ; les dates/propriétaires tar sont
normalisés. Un fichier d'artefact déjà suivi n'est séparé des sources que si son
empreinte est identique à celle déclarée. Les liens et sous-modules bloquent la
version plutôt que d'être ignorés. Les sources et artefacts ont une adresse SHA-256
dans `bundle/objects/` ; les descripteurs conservent les URLs de provenance.

Les téléchargements administratifs acceptent seulement les URLs HTTPS de releases
GitHub, suivent leurs redirections HTTPS et vérifient les empreintes. Aucune
recherche d'URL, reconstruction ou substitution automatique ne masque un artefact
manquant. Un cache corrompu est refusé. L'outil peut reprendre les objets vérifiés ;
les téléchargements `.partial` ne sont pas admissibles. Une version incomplète
n'obtient aucun descripteur importable. Le rapport de préparation est une observation,
pas une autorisation de publication. L'admission PHP vérifie ensuite indépendamment
les objets et toutes les archives. Elle ne prouve pas l'exécution des sources.

## Rattacher puis importer

L'opérateur doit vérifier les droits de chaque nom : inscription immuable,
propriété effective et identité GitHub stable authentifiée. Le pseudo et l'URL
du dépôt ne constituent pas seuls cette preuve. Préparer un fichier administratif
relu, jamais issu d'une requête cliente :

```json
{
  "schema": 1,
  "owners": [{
    "name": "Example",
    "repository": "https://github.com/owner/package.git",
    "registration_sha256": "empreinte SHA-256 des octets du fichier d'inscription",
    "github_id": "identifiant numérique stable vérifié",
    "login": "pseudo utile",
    "evidence": "Référence précise de la vérification et de son autorité administrative."
  }]
}
```

Le service ne vérifie pas magiquement le texte `evidence` : le compte système
capable d'exécuter cet outil est l'autorité administrative. Ne pas exposer ce fichier
ou l'outil aux auteurs. Les seules données d'identité nécessaires sont conservées.

```sh
php server/bin/migrate.php /absolute/data /absolute/bundle /absolute/owners.json STD@0.22.0 GFX@0.40.0
```

Initialiser un magasin vide avec `storage.php init` si nécessaire. Choisir l'ordre
des versions afin que leurs dépendances d'exécution soient déjà publiées ; rattacher
aussi les parents des noms pointés. L'import vérifie tout le lot avant de rattacher
les noms. Il utilise ensuite la même admission, le même verrou, les offsets et la
finalisation atomique que les auteurs. Une interruption entre deux versions laisse
le préfixe publié ; relancer exactement la même commande reprend les uploads et
retrouve les versions existantes. Une autre identité ou provenance est refusée.
Les droits et provenances sont conservés dans les tables administratives
`migration_owners` et `migration_versions`.

`plan.mjs` calcule cet ordre depuis les seuls descripteurs préparés et signale
les dépendances absentes ou cycliques. Il suit les contraintes exactes et caret
du registre, sans imposer la convention npm pour les versions 0.x. Le plan
n'autorise aucun rattachement et ne remplace pas l'admission finale du serveur.

Les accès temporaires de l'import sont aléatoires, bornés à une heure, hachés en
base et révoqués à la sortie normale ; un processus tué les laisse expirer.
Aucun accès n'est imprimé. Les limites ordinaires et marges disque s'appliquent :
ne pas employer les minuscules quotas du corpus hostile pour un lot réel.

## Sauvegarder et restaurer

```sh
php server/bin/snapshot.php create /absolute/data /absolute/new-snapshot
php server/bin/snapshot.php verify /absolute/new-snapshot MANIFEST_SHA256
php server/bin/snapshot.php restore /absolute/new-snapshot /absolute/new-data MANIFEST_SHA256
```

La création prend le verrou des écritures pendant le snapshot SQLite (`VACUUM INTO`)
et la copie des objets, uploads, limites et clé de login éventuelle. Les fichiers
sont synchronisés, puis `snapshot.json` est écrit en dernier. Une création
interrompue n'est pas une sauvegarde validée. Prévoir une fenêtre d'exploitation :
un gros snapshot peut faire attendre ou refuser proprement les nouvelles écritures.
Contrôler l'espace disponible pour une copie complète ; l'outil ne purge aucune
sauvegarde ni version pour gagner de la place.

Conserver l'empreinte retournée séparément dans une trace administrative fiable.
Elle vérifie l'intégrité, pas l'authenticité d'un instantané reçu sans provenance.
La vérification contrôle les fichiers, l'intégrité SQLite, les clés étrangères,
les descripteurs, leurs références et les objets publiés. Le magasin restauré
n'est activable qu'une fois son marqueur `mutation.lock` créé en dernier. Ne jamais
pointer un service vers une restauration inachevée. En cas d'échec, préserver
l'essai pour diagnostic et recommencer dans un autre répertoire vide.

La restauration ne remplace jamais un répertoire existant. Elle conserve les
versions et les droits, mais invalide tous les accès et tentatives de connexion :
les auteurs se reconnectent afin qu'une ancienne sauvegarde ne réactive pas des
sessions révoquées depuis. Les uploads encore valides peuvent reprendre après
réauthentification ; les expirés suivent la collecte habituelle.

Ces instantanés privés peuvent contenir une clé de login et des données d'identité.
Ne pas les publier ni les placer dans un dépôt Git. Leurs fichiers sont en 0600,
leurs répertoires en 0700. Avant une exploitation réelle, choisir explicitement
une destination hors VPS, le chiffrement, la garde des clés, la fréquence, la
rétention et les alertes d'échec. Une copie locale de qualification ne constitue
pas à elle seule cette politique opérationnelle. Aucun service payant n'est choisi
ou configuré par ces outils.

## Qualification

`server/tests/migration-inventory.mjs` vérifie les tags et les archives déterministes.
Depuis le groupe de worktrees, `node Silex-Registry/server/tests/run-migration.mjs
/absolute/php` éprouve import, coupure, droits et restauration. Le banc
`run-migrated-install.mjs` reçoit PHP, Silex, une base restaurée et le bundle ; il
compare les installations anonymes des témoins STD/JSON/GFX pour les six cibles,
avec Git et les téléchargements d'origine désactivés. Il ne lance pas leurs
binaires natifs.

Sur le staging VPS explicitement autorisé, `server/staging/migration.sh` emploie
`migration-input/{bundle,owners.json}` et `migration-work/{data,snapshot,restored}`
sous `/var/lib/silex-registry-stage`. Ces chemins sont distincts de `data/` et du
registre public. L'entrée doit appartenir à root et être lisible par le compte de
staging ; le runtime reçoit seulement cette entrée en lecture seule, le code
déployé en lecture seule et le répertoire de qualification en écriture, sans
réseau. Les actions sont `init`, `import data <sélections>`, `snapshot`,
`verify <empreinte>`, `restore <empreinte>` et `import restored <sélections>`.
