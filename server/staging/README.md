# Staging privé du registre v2

Ce dossier prépare une instance de qualification sur une VPS Debian x64 équipée
de systemd. Il ne modifie pas les pools PHP, vhosts ou données du registre public.
Les scripts d'installation sont des opérations administratives ; les exécuter
uniquement sur l'hôte autorisé et après examen des chemins ci-dessous.

## Environnement

`prepare-runtime.sh` télécharge les paquets Debian Bookworm signés et les extrait
sous `/var/lib/silex-registry-stage/root`. Il ne lance aucun script d'installation
de paquet sur l'hôte. Ses index APT et archives sont privés ; les empreintes
téléchargées sont conservées dans `runtime-sha256.txt`. Arrêter les deux services
de staging avant de reconstruire ce runtime. La mise à jour de la distribution
de l'hôte et de ses dépôts APT est une opération distincte.

`install-stage.sh ARCHIVE COMMIT` installe un export Git du registre contenant
`server/` et `registry/v1/packages/`, crée deux comptes système sans connexion et
les services `silex-registry-stage` et `silex-registry-stage-web`. L'empreinte de
l'archive doit rester identique pour une release existante. Les données restent
sous `data/`, séparées de `releases/<COMMIT>`. Le script conserve la base lors
d'une réinstallation et vérifie la réponse HTTPS de l'application avant succès.

FPM travaille dans une racine privée en lecture seule, avec uniquement `/data`,
son répertoire d'exécution et un `/tmp` temporaire en écriture. Le profil interdit
TCP, l'élévation de privilèges et les fonctions PHP de lancement de processus.
PCRE fonctionne sans JIT pour respecter l'interdiction de mémoire exécutable
dynamique. Les données reçues sont inspectées, jamais compilées ou exécutées.

La passerelle HTTPS a son propre compte. Elle monte le socket FPM, mais pas les
données ; elle écoute uniquement sur `127.0.0.1:18765`. Le certificat autonome
de 30 jours est réservé au tunnel de qualification. Les journaux opérationnels
sont dans `/run/silex-registry-stage/` et `/run/silex-registry-stage-web/` ; ils
sont temporaires. Le répertoire FPM reste en place pendant un redémarrage afin
que le montage du socket côté passerelle reste valide ; il disparaît à l'arrêt
complet du service. Les résultats
des sondes de démarrage sont aussi conservés par journald.

Le profil sans réseau laisse la connexion GitHub désactivée. Le banc injecte
des identités synthétiques via l'administrateur SSH et révoque ses jetons dans
un bloc de nettoyage. Aucune route HTTP ne permet cette injection. Les limites
réduites de `limits.json` servent aux cas adverses et ne sont pas des quotas de
production. La qualification OAuth sur cet hôte reste à traiter avant une
ouverture publique.

## Sauvegarder le magasin actif

`silex-registry-stage-snapshot` crée un instantané du magasin réellement servi
dans `data/`, sous `backups/`, en prenant le verrou de mutation du registre. Il
ne modifie pas le registre public et n'écrase jamais un instantané existant.
Choisir un nom UTC unique de forme `stage-YYYYMMDDTHHMMSSZ` :

```sh
sudo /usr/local/libexec/silex-registry-stage-snapshot create stage-20260916T120000Z
sudo /usr/local/libexec/silex-registry-stage-snapshot verify stage-20260916T120000Z EMPREINTE_SHA256
```

Conserver l'empreinte retournée hors VPS, puis copier cet instantané vers la
destination indépendante avec `server/migration/copy-snapshot.mjs` et y relancer
la vérification et une restauration dans un répertoire vide. Le processus
administratif reste sans réseau ; seule la copie initiée depuis le poste utilise
SSH. Le snapshot peut bloquer temporairement les écritures du service : choisir
une fenêtre adaptée et vérifier l'espace libre avant de le lancer. Les copies
restent privées et ne sont pas purgées automatiquement. Ni fréquence ni alerte
ne sont configurées par ce script ; une sauvegarde ponctuelle ne constitue pas
une politique d'exploitation.

## Qualification

Les sondes `isolation.php`, lancées dans les mêmes comptes et espaces de noms
que les services, refusent le démarrage si le stockage propre n'est pas utilisable
ou si les frontières de fichiers/réseau ne sont pas respectées.

Ouvrir un tunnel depuis le poste :

```sh
ssh -N -L 127.0.0.1:18765:127.0.0.1:18765 debian@vps
```

Copier uniquement le certificat public `gateway/tls.crt`, puis lancer le banc
avec son chemin local. Ne jamais désactiver la vérification TLS :

```sh
node server/tests/run-staging.mjs debian@vps https://127.0.0.1:18765 /absolute/path/tls.crt
```

Le banc publie des packages `Stage_*`, vérifie la lecture exacte et les refus
hostiles, révoque ses accès puis tue volontairement le maître FPM. Il vérifie
la récupération automatique de la publication après redémarrage. Ce test est
réservé au staging. Les contenus de preuve restent dans sa base pour inspection.

Pour désactiver l'instance, arrêter et désactiver les deux services systemd.
Conserver les données et releases pour inspection ou reprise ; aucune suppression
récursive n'est nécessaire pour revenir au service public existant.
