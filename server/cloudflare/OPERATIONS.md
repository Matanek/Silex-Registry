# Exploiter le registre Cloudflare

## État du service

Le registre public emploie un Worker, une base D1 et un bucket R2 dédiés. Les
configurations contenant les identifiants de ces ressources restent locales et
sont ignorées par Git. La lecture de STD et d'un gros artefact natif,
l'installation, la publication d'auteur et l'exécution d'un consommateur ont
réussi. Le client compatible Silex `0.45.0` choisit le protocole D1/R2 grâce à
`/v2/capabilities`. Les anciens clients qui lisent uniquement les tags Git ne
peuvent pas installer les versions stockées sur Cloudflare.

## Préparer et qualifier une destination

1. Créer Worker, base D1 et bucket R2 dédiés. Copier
   `wrangler.production.example.toml`, renseigner les identifiants et choisir
   le routage public seulement au moment autorisé. Ne jamais restaurer dans
   le staging ou dans un service actif. Appliquer les cinq migrations D1 à
   la base vide.
2. Poser `LOGIN_KEY_B64` et `MAINTENANCE_TOKEN_SHA256` via les secrets Wrangler,
   hors de Git et des copies. Le second est le SHA-256 d'un jeton aléatoire de
   64 chiffres hexadécimaux ; seul l'administrateur possède le jeton brut
   `REGISTRY_MAINTENANCE_TOKEN`. Ne pas configurer `STAGING_TOKEN_SHA256` en
   production : les routes `__probe` doivent y rester inaccessibles.
3. Exécuter `admin/validate-bundle.mjs`, puis `admin/import-bundle.mjs` avec
   l'origine et le jeton administratifs de cette destination. Rejouer l'import :
   zéro version supplémentaire doit apparaître. Toute collision différente
   doit arrêter la migration.
4. Vérifier `GET /v2/capabilities` sans identité, comptes D1, objets R2 et
   SHA-256 d'une source et d'un gros artefact
   en lecture publique. Installer depuis un magasin Silex vide et compiler un
   consommateur. Publier puis installer deux versions d'un nom de banc, et
   supprimer uniquement cette fixture avec `tests/cleanup-remote.mjs`.

`GFX.Nodes` conserve un propriétaire mais pas de version importable.
`GFX.Audio@0.4.0` reste absente faute de deux artefacts historiques ; aucun
octet actuel ne peut remplacer ces objets sans preuve d'identité.

## Copies et reprise

Le registre de production copie chaque publication vers le bucket privé
Backblaze B2 désigné par `BACKUP_BUCKET`, sous le préfixe configuré.
Les objets binaires sont adressés par SHA-256 ; les descripteurs de publication
et un instantané déterministe des propriétaires et versions complètent la
copie. Chaque envoi porte son checksum S3, emploie le chiffrement serveur AES256
et reçoit une rétention Object Lock en mode Governance de 90 jours. Une
publication n'est rendue visible qu'après l'enregistrement de ses éléments
dans la file Cloudflare configurée par Wrangler.

Le consommateur de cette file relit les octets depuis R2 et les métadonnées
depuis D1, écrit B2, puis vérifie taille et SHA-256 par `HEAD` avant
d'acquitter le message. Les échecs sont rejoués et finissent dans la file
d'échec configurée après dix tentatives. Le cron Cloudflare
`15 3 * * *` produit un nouvel instantané et supprime les sessions d'upload
expirées. Aucune machine personnelle, tâche `launchd` ou copie locale n'est
requise pour cette maintenance.

`admin/restore-b2.mjs --remote DATABASE BUCKET CONFIG` choisit le dernier
instantané valide d'un préfixe B2, télécharge chaque objet dans un dossier
temporaire, contrôle taille, SHA-256, archives source et dépendances, puis
restaure uniquement vers une base D1 et un bucket R2 vides. Fournir
`B2_ENDPOINT`, `B2_BUCKET`, `B2_PREFIX`, `B2_APPLICATION_KEY_ID`,
`B2_APPLICATION_KEY`, `REGISTRY_ADMIN_ORIGIN` et
`REGISTRY_MAINTENANCE_TOKEN` hors de Git. Comparer ensuite l'inventaire,
télécharger une source publique et refaire une connexion auteur avant toute
bascule DNS. Les sessions de connexion ne sont pas sauvegardées ; les droits
de noms restent attachés aux identifiants GitHub stables.

La qualification a copié l'intégralité du corpus dans B2. Une restauration
dans des ressources Cloudflare neuves a recréé exactement les propriétaires,
versions et objets attendus. Les ressources de restauration ont ensuite été
supprimées. Le préfixe de qualification reste conservé par Object Lock, mais
`BACKUP_REQUIRED=0` y empêche toute croissance future.

`admin/export-store.mjs` et `admin/restore-backup.mjs` restent disponibles pour
une copie manuelle ponctuelle. Ils ne participent plus à la continuité du
service et ne doivent pas être planifiés sur un poste personnel.

## Rétention, surveillance et coûts

Les sessions sont reprenables sept jours. Le cron Worker supprime après huit
jours les fragments R2 avant les lignes D1 ; il ne vise jamais les objets
canoniques.
Surveiller les 5xx, erreurs de connexion GitHub, publications refusées,
sessions bloquées, latence des gros objets, occupation D1/R2, opérations et
coût facturé. Alerter sur les copies ou purges en échec, les fragments trop
anciens, la hausse durable des 5xx et l'approche des quotas.

Le Worker refuse une nouvelle publication si le volume logique unique dépasse
8 Gio, afin de garder une marge sous l'allocation gratuite B2. Ce garde-fou ne
remplace pas les plafonds et alertes du compte Backblaze. Aucun upgrade payant
n'est implicite. Contrôler régulièrement les tableaux de bord et les limites
publiées ; ne jamais publier dans Git les captures, identifiants de ressources
ou détails de facturation du compte.

Consulter les références officielles [Workers](https://developers.cloudflare.com/workers/platform/limits/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/) et
[R2](https://developers.cloudflare.com/r2/pricing/).

## Déploiement et retour arrière

### Domaine officiel

La zone DNS Cloudflare est active. Wrangler attache
`registry.silex-lang.org` au Worker de production par Custom Domain. Le
certificat HTTPS est valide, `/v2/capabilities` retourne
`silex-registry-v2` et DNSSEC est actif. Les autres services du domaine sont
gérés indépendamment du registre.

Voir les [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
les [configurations DNS](https://developers.cloudflare.com/dns/zone-setups/),
et la [délégation](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/).

La lecture anonyme de `STD@0.22.0` depuis le domaine officiel a réussi avec
Silex `0.45.0`. La publication d'auteur, la copie B2 et une restauration
complète ont aussi été qualifiées.

Déployer code et migrations compatibles sans changer le nom public. La route
publique `/v2/capabilities` répond avec le protocole
`silex-registry-v2` ; son absence sur l'ancien serveur maintenait les nouveaux
clients sur `/v1`, tandis qu'une erreur réseau arrêtait la résolution.
Sur la version Worker exacte, répéter lecture, publication, installation,
intégrité et restauration.

Un Worker antérieur ne peut être réactivé que s'il lit le schéma D1 et les
objets écrits par le nouveau. Les migrations doivent rester additives. Avant
la bascule, revenir à la version Worker antérieure et revérifier la lecture
si le déploiement échoue. Après une nouvelle publication, garder le routage
Cloudflare, restaurer un Worker compatible ou restaurer une copie complète
dans une autre instance. Réconcilier toute version créée depuis la dernière
copie ; ne pas l'écraser. Cloudflare conserve D1/R2 lors d'un retour arrière du
code ; cela ne prouve pas qu'un Worker incompatible avec de futures migrations
serait sûr.
La [procédure Cloudflare de rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
précise aussi ses limites de bindings et de versions disponibles.
