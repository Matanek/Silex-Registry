# Exploiter le registre Cloudflare

## État de la bascule

Le Worker `silex-registry-staging-probe.silex-lang.workers.dev` est un banc
public isolé du registre officiel. D1/R2 staging contiennent 155 versions,
30 noms réservés et 171 objets distincts. Une autre base et un autre bucket,
`silex-registry-restore-probe`, ont reçu une restauration complète. Aucun DNS
public du registre n'a été modifié. Le client compatible doit être publié
avant la bascule : il continue à utiliser l'index `/v1` tant que la capacité
`/v2/capabilities` est absente, puis choisit D1/R2 après l'activation.
Les anciens clients qui lisent les tags Git ne peuvent pas installer les
versions stockées sur Cloudflare.

## Préparer et qualifier une destination

1. Créer Worker, base D1 et bucket R2 dédiés. Copier
   `wrangler.production.example.toml`, renseigner les identifiants et choisir
   le routage public seulement au moment autorisé. Ne jamais restaurer dans
   le staging ou dans un service actif. Appliquer les trois migrations D1 à
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

`admin/export-store.mjs` crée un nouveau dossier sous
`SilexProject/Backups/Silex-Registry`. Il relit les métadonnées D1 au début et
à la fin, contrôle chaque objet par taille et SHA-256 et refuse une copie
prise pendant une modification visible. La copie comprend versions, noms et
droits. Elle exclut jetons, clés de connexion, sessions et fragments d'upload.
Conserver plusieurs copies datées et une copie hors du compte Cloudflare,
avec accès restreint et support chiffré : elles contiennent du code d'auteurs
et des identifiants. Vérifier chaque copie et tester périodiquement sa
restauration.

`admin/restore-backup.mjs` revérifie la copie et la restaure seulement dans
une base D1 vide et un bucket R2 distincts. Le Worker lié à cette destination
pose les métadonnées SHA-256 requises par la lecture R2. Comparer ensuite
l'inventaire et les condensats, installer un package depuis un magasin vide,
puis refaire une connexion auteur avant une nouvelle publication. Les accès
anciens ne sont pas restaurés ; les droits restent attachés aux identifiants
GitHub stables. En cas de perte du compte, créer des ressources dans un compte
autorisé, restaurer la dernière copie hors compte, recréer les secrets et
qualifier la nouvelle instance avant de déplacer le DNS. La perte maximale
de données dépend de l'âge de la dernière copie valide.

Programmer `admin/run-maintenance.mjs` quotidiennement après activation, avec
`--apply-retention`, depuis une machine dont le compte Cloudflare et le
dossier de copies restent accessibles. Elle effectue la copie vérifiée avant
la purge, garde les trente dernières copies automatiques et un point par mois
sur les douze derniers mois, puis émet un reçu JSON. Seuls les dossiers
`cloudflare-auto-*` marqués comme complets peuvent être supprimés ; les copies
manuelles et anciennes VPS restent intactes. Contrôler la sortie et alerter
sur toute fin non nulle ou absence de copie quotidienne. Tester une
restauration périodique et transférer une copie hors du compte. Le script est
qualifié localement ; aucun calendrier système n'est encore activé.

## Rétention, surveillance et coûts

Les sessions sont reprenables sept jours. Exécuter
`admin/prune-sessions.mjs` quotidiennement pour supprimer après huit jours
les fragments R2 avant les lignes D1 ; ne jamais viser les objets canoniques.
Surveiller les 5xx, erreurs de connexion GitHub, publications refusées,
sessions bloquées, latence des gros objets, occupation D1/R2, opérations et
coût facturé. Alerter sur les copies ou purges en échec, les fragments trop
anciens, la hausse durable des 5xx et l'approche des quotas.

Le corpus représente 288 930 458 octets d'objets uniques, hors sessions et
croissance. L'artefact SDL de 51 047 580 octets exerce la voie des gros
objets. Relever dans le compte cible le plan, les quotas Workers/D1/R2 et
les lectures/écritures avant la bascule. Les allocations gratuites ne sont
pas un plafond de facturation : fixer une alerte de dépense et vérifier les
conditions actuelles du plan. Aucun upgrade payant n'est implicite.
À la fin des essais, l'inventaire direct du Worker de staging trouve 171 objets
canoniques pour 288 930 458 octets et aucun fragment d'upload ;
D1 occupe 2 023 424 octets. La restauration garde une seconde copie R2 du
même corpus ; les deux buckets totalisent donc au moins 577 860 916 octets
hors fragments temporaires. Les seuils publics actuels du plan gratuit sont
100 000 requêtes Worker par jour avec 10 ms de CPU par invocation,
5 millions de lignes D1 lues et 100 000
écrites par jour, 5 Go D1, et pour R2 Standard 10 Go-mois, 1 million
d'opérations A et 10 millions B par mois. Ces mesures de stockage sont sous
les allocations publiées. Les captures du tableau de bord fournies le
18 septembre 2026 affichent, pour la période courante R2, 0,00 $ d'usage
facturable, 3,56 milliers d'opérations A, 9,86 milliers d'opérations B et
288,94 Mo de stockage total. La page D1 affiche aussi 0,00 $ d'usage
facturable, 430,65 milliers de lignes lues, 9,11 milliers écrites et
4,06 Mo de stockage total, avec deux bases sur dix permises. Cette limite de
dix bases indique le forfait Workers Free selon les
[limites D1](https://developers.cloudflare.com/d1/platform/limits/) ; c'est
une déduction de la capture, qui ne nomme pas directement le forfait.
L'analytique
Workers sur 24 heures indique environ 6,94 milliers d'invocations, zéro
erreur et un P90 CPU de 5 ms. Le forfait Workers Free ne comporte pas de frais
fixes selon les [tarifs Workers](https://developers.cloudflare.com/workers/platform/pricing/).
Les captures étayent donc l'absence d'usage facturable du registre dans les
vues D1/R2 et l'application probable du forfait gratuit Workers. Elles ne
constituent pas une facture globale du compte ni une garantie pour le trafic
futur ; contrôler la facturation et les quotas au moment de la bascule.

La même capture R2 affiche 264 objets dans le bucket de staging. Un inventaire
complet du bucket, lu ensuite par un Worker local éphémère avec binding R2 réel,
trouve exactement 171 objets canoniques, zéro fragment et zéro autre clé, pour
288 930 458 octets. Le compteur de la capture ne décrit donc pas l'état lu à
ce contrôle ; sa date de rafraîchissement effective reste inconnue. Ne supprimer
aucun objet sur la seule foi des compteurs du tableau de bord.
Consulter les références officielles [Workers](https://developers.cloudflare.com/workers/platform/limits/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/) et
[R2](https://developers.cloudflare.com/r2/pricing/) avant l'activation.

## Déploiement et retour arrière

Déployer code et migrations compatibles sans changer le nom public. La route
publique `/v2/capabilities` doit répondre exactement avec le protocole
`silex-registry-v2` avant le changement de domaine ; son absence maintient
les nouveaux clients sur `/v1`, tandis qu'une erreur réseau arrête la
résolution. Sur la
version Worker exacte, répéter lecture, publication, installation, intégrité
et restauration. Copier le magasin avant la bascule, puis déplacer le routage
public seulement après accord sur le client, le service et le DNS. Garder
la VPS et ses sauvegardes indépendantes pendant l'observation initiale.

Un Worker antérieur ne peut être réactivé que s'il lit le schéma D1 et les
objets écrits par le nouveau. Les migrations doivent rester additives. Avant
la bascule, revenir à la version Worker antérieure et revérifier la lecture
si le déploiement échoue. Après une nouvelle publication sur Cloudflare,
renvoyer le DNS vers l'ancien registre rendrait cette version invisible :
garder le routage Cloudflare, restaurer un Worker compatible ou restaurer une
copie complète dans une autre instance. Réconcilier toute version créée depuis
la dernière copie ; ne pas l'écraser. Retirer la VPS seulement après copies
hors compte, surveillance et décision explicite.

L'essai de staging a déployé temporairement la version Worker
`240443de-830d-4cc9-af42-f2a710b0c6c6`, relu `STD@0.16.0/source` avec son
SHA-256 historique, puis rétabli la version
`f84371bb-5e67-476a-b26b-60062ed9e8c1` et revérifié les mêmes octets.
Cloudflare conserve D1/R2 lors d'un retour arrière du code ; cet essai ne
prouve pas qu'un Worker incompatible avec de futures migrations serait sûr.
La [procédure Cloudflare de rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
précise aussi ses limites de bindings et de versions disponibles.
