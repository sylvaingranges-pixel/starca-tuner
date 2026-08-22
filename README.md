# Starca Tuner

Application **locale, dans un onglet de navigateur**, pour analyser et retoucher une sortie
vélo enregistrée par un Garmin (Edge 540, export Garmin Connect) ou exportée de Strava,
au format **GPX**.

Aucune installation, aucun serveur, aucun envoi de données : le fichier est lu et réécrit
dans le navigateur. Seules les tuiles du fond de carte viennent d'Internet.

## Lancer l'application

Deux possibilités :

* **fichier unique** — ouvrez `starca-tuner.html` (double-clic, ou glissez-le dans un onglet).
  Tout y est embarqué : c'est le fichier à copier sur une clé ou une autre machine ;
* **arborescence** — ouvrez `index.html` (même contenu, code séparé en modules).

Le fichier unique se régénère après modification du code avec `node tools/build-single.js`.

## Ce que fait l'application

1. **Import** d'un GPX Garmin Connect / Strava. Tous les champs présents dans le fichier
   deviennent des séries : altitude, fréquence cardiaque, cadence, température, puissance…
   plus les séries calculées **vitesse** et **pente (en degrés)**.
2. **Séries temporelles synchronisées** : molette pour zoomer, glisser pour sélectionner,
   `maj`+glisser pour déplacer. Tous les graphes partagent la même fenêtre en X, qui peut
   être le **temps** ou la **distance depuis le départ**. Chaque graphe a son axe Y
   **automatique** (recalculé sur la fenêtre visible) ou **fixé manuellement** entre un min
   et un max.
3. **Carte** (fond OpenStreetMap / OpenTopoMap / CyclOSM / Carto, ou aucun fond) : le tracé
   complet est en bleu pâle, **la portion visible dans les graphes en bleu vif**, la
   **sélection en orange**. La sélection fonctionne dans les deux sens : à la souris dans un
   graphe, ou en glissant le long du tracé sur la carte (bouton « Sélection sur la carte »).
4. **Retouche du tronçon sélectionné** : on choisit un objectif — *gagner tant de temps*,
   *multiplier la vitesse*, *ajouter des km/h*, *viser une vitesse minimale* — et surtout
   **quels points sont concernés**, via des filtres cumulables sur n'importe quelle série :
   pente en degrés, vitesse d'origine, puissance, fréquence cardiaque, cadence, altitude…
   L'accélération n'est donc pas uniforme : on peut par exemple ne gagner du temps que dans
   les montées à plus de 2° où l'on roulait à moins de 20 km/h.
   Une transition progressive (raccord aux extrémités, lissage) évite les ruptures de vitesse.
5. **Empilement des modifications** : chaque retouche appliquée s'ajoute à la liste et peut
   être désactivée ou supprimée ; on sélectionne ensuite un autre tronçon et on recommence.
   La courbe orange sur le graphe de vitesse montre en permanence le résultat.
6. **Export** : le GPX est recalculé, vérifié, puis téléchargé.

## Comment le fichier de sortie est reconstruit

Le tracé (la polyligne) et la cadence d'enregistrement sont des invariants ; seul le
**déroulement du temps le long du parcours** change.

* pour chaque intervalle retouché, la nouvelle durée vaut `durée d'origine ÷ facteur` ;
* on obtient une nouvelle date de passage sur chaque point du tracé, puis on **ré-échantillonne**
  à la cadence d'origine (1 Hz sur un Edge) : chaque point exporté est **interpolé le long du
  tracé d'origine**, à la position réellement atteinte à cet instant. Positions et vitesses
  restent donc cohérentes, et les points restent sur la route (écart mesuré < 1 m) ;
* les **pauses d'enregistrement** du fichier d'origine sont conservées, à l'endroit du parcours
  où elles ont eu lieu ;
* les **horodatages** restent sur la grille de la seconde de l'origine : identiques avant la
  première retouche, décalés ensuite du temps gagné (arrondi à la seconde entière, option
  « Caler le gain sur la seconde entière »). La sortie se termine simplement plus tôt, avec
  d'autant moins de points ;
* toutes les autres séries (FC, cadence, température, puissance…) suivent la position, avec
  la même structure d'extensions XML que le fichier d'entrée. Deux options recalculent
  **puissance** et **fréquence cardiaque** en cohérence avec la nouvelle vitesse, à partir d'un
  modèle physique paramétrable (masse, SCx, Crr) ;
* sans aucune modification, l'export est **identique au fichier d'entrée**, octet pour octet,
  sur l'ensemble des points de trace.

La distance totale est conservée à ~0,05 % près (le ré-échantillonnage lisse très légèrement
le bruit GPS dans les portions retouchées).

## Import dans Strava

Avant le téléchargement, l'application vérifie le fichier produit : structure et ordre des
éléments du schéma **GPX 1.1**, espaces de noms déclarés, coordonnées valides, horodatages
ISO-8601 strictement croissants, taille compatible avec la limite d'envoi de Strava. Le rapport
s'affiche dans la fenêtre d'export.

Import : *Ajouter → Fichier* sur strava.com, ou glisser le fichier sur
<https://www.strava.com/upload>. L'attribut `creator` et le nom de l'activité sont repris tels
quels du fichier d'origine ; Strava recalcule ses propres statistiques (temps de déplacement,
vitesse moyenne, segments) à partir des points.

À noter : Strava refuse un fichier dont l'activité fait doublon avec une activité déjà
présente (même date de départ). Supprimez l'activité d'origine, ou décalez la date, avant
d'importer la version retouchée.

## Raccourcis

| touche | effet |
| --- | --- |
| glisser | sélectionner un tronçon |
| `maj` + glisser | déplacer la vue (graphes) / inverser le mode (carte) |
| molette | zoom X synchronisé |
| double-clic, `r` | vue complète |
| `z` | zoom sur la sélection |
| `m` | mode « sélection sur la carte » |
| `entrée` | appliquer la retouche au tronçon |
| `échap` | effacer la sélection / fermer la fenêtre |

## Développement

```
node tools/test-all.js                    # toute la chaîne de vérification
node tools/make-sample.js                 # regénère les exemples synthétiques
node tools/selftest.js [fichier.gpx]      # tests du moteur (lecture, édition, export)
node tools/validate-gpx.js fichier.gpx    # validation GPX 1.1 en ligne de commande
node tools/uitest.js [fichier.gpx]        # test d'interface (Playwright + Chromium)
node tools/build-single.js                # regénère starca-tuner.html
```

Découpage du code :

| fichier | rôle |
| --- | --- |
| `js/xml.js` | mini parseur / sérialiseur XML (navigateur et Node) |
| `js/gpx.js` | lecture et écriture GPX, extensions génériques |
| `js/track.js` | distance, vitesse, pente, canaux de données |
| `js/edit.js` | filtres, facteurs de vitesse, ré-échantillonnage |
| `js/validate.js` | contrôle GPX 1.1 / Strava |
| `js/charts.js` | graphes synchronisés (canvas) |
| `js/map.js` | carte à tuiles (canvas, sans bibliothèque) |
| `js/app.js` | interface et enchaînement |

Les fichiers `sample/sample-ride.gpx` (mise en forme Garmin Connect) et
`sample/sample-ride-strava.gpx` (mise en forme Strava : préfixe `gpxtpx:`, `<power>` en
enfant direct de `<extensions>`, deux `<trkseg>`) sont des enregistrements **synthétiques**
générés par `tools/make-sample.js` : aucune trace GPS personnelle n'est versionnée ici.
Les tests couvrent aussi le cas minimal (ni altitude ni extensions).
