# Starca Tuner

Application **locale, dans un onglet de navigateur**, pour analyser et retoucher une sortie
vélo enregistrée par un Garmin (Edge 540, export Garmin Connect) ou exportée de Strava,
au format **GPX**.

Aucune installation, aucun serveur, aucun envoi de données : le fichier est lu et réécrit
dans le navigateur. Seules les tuiles du fond de carte viennent d'Internet.

## Lancer l'application

Deux interfaces, le même moteur, toutes deux dans un simple onglet de navigateur :

| | fichier unique | arborescence |
| --- | --- | --- |
| **ordinateur** | `starca-tuner.html` | `index.html` |
| **smartphone** | `starca-tuner-mobile.html` | `mobile.html` |

Les fichiers uniques embarquent tout (aucune dépendance) : ce sont ceux à copier sur une clé,
un téléphone ou une autre machine. Ils se régénèrent avec `node tools/build-single.js`.

### Version smartphone

Même chaîne de traitement et mêmes fonctions que la version bureau, avec une disposition
verticale et des gestes tactiles :

* **un doigt** sur un graphe : sélectionner un tronçon · **deux doigts** : zoomer et se
  déplacer, tous les graphes restant synchronisés · **double-tap** : vue complète ;
* carte au-dessus des graphes, hauteur réglable en faisant glisser la poignée (un appui
  fait défiler trois tailles, jusqu'au plein écran) ; deux doigts pour zoomer sur la carte ;
* trois séries affichées au départ pour rester lisible — l'onglet **Graphes** permet
  d'afficher toutes les autres et de figer un axe Y entre deux valeurs ;
* la retouche, les modifications empilées, les réglages (dont la date de la sortie et le
  recalcul puissance / FC) et l'export s'ouvrent en **feuilles glissantes** depuis la barre
  du bas ;
* en paysage, la carte passe à gauche et les graphes à droite ;
* à l'export, un bouton **Partager** apparaît quand le navigateur le permet (iOS, Android) :
  le GPX part directement vers Fichiers, Drive ou l'appli Strava.

Pour l'installer sur le téléphone : ouvrez `starca-tuner-mobile.html` (depuis Fichiers,
Drive ou un partage local) puis « Ajouter à l'écran d'accueil » — la page fonctionne
ensuite comme une application, hors ligne, sauf le fond de carte.

## Quel fichier donner à l'application ?

| export | puissance | lu par l'app | remarque |
| --- | --- | --- | --- |
| **Strava → « Exporter GPX »** | **oui** (`<power>`) | oui | **le meilleur choix** : 1 Hz, puissance, FC, cadence, température, altitude |
| Garmin Connect → « Exporter au format GPX » | non | oui | l'extension Garmin `TrackPointExtension v1` ne transporte que `atemp`, `hr` et `cad` : la puissance n'y est jamais, même avec un capteur |
| Strava / Garmin → fichier original `.fit` | oui | non | format binaire ; contient en plus la respiration, l'équilibre G/D, l'efficacité de pédalage, les tours… |

Autrement dit : si votre sortie a été enregistrée avec un capteur de puissance, exportez-la
**depuis Strava en GPX** — c'est le même enregistrement à 1 Hz que le GPX Garmin, avec la
puissance en plus. Le graphe « Puissance » apparaît alors automatiquement et devient
utilisable comme filtre de retouche.

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
6. **Aperçu « après retouche »** : une courbe orange se superpose à la série d'origine, sur
   les mêmes abscisses, partout où quelque chose change. Toujours pour la **vitesse** ; pour
   la **puissance** et la **fréquence cardiaque** dès que leur recalcul est coché — l'en-tête
   du graphe affiche alors la comparaison sous le curseur (`277 → 307`). L'aperçu emploie
   exactement le même calcul que l'export, ce que vérifie la suite de tests.
7. **Date de la sortie** modifiable : tous les horodatages — et la date de `<metadata>` —
   sont décalés d'autant, la durée et l'enchaînement restant identiques. Pratique parce que
   Strava refuse une activité dont la date de départ existe déjà.
8. **Export** : le GPX est recalculé, vérifié, puis téléchargé.

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
  modèle physique paramétrable (masse, SCx, Crr). La puissance suit le rapport des puissances
  nécessaires avant et après (roulement, pesanteur, aérodynamique), la FC suit ce rapport de
  façon amortie et plafonnée. À noter : une portion roue libre enregistrée à 0 W reste à 0 W —
  un rapport multiplicatif ne crée pas de puissance à partir de rien ;
* sans aucune modification, l'export est **identique au fichier d'entrée**, octet pour octet —
  y compris l'en-tête, les espaces de noms, le style d'indentation, la précision des altitudes
  et le découpage en `<trkseg>` (vérifié sur les exports Garmin Connect et Strava).

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
node tools/uitest.js [fichier.gpx]        # test d'interface bureau (Playwright + Chromium)
node tools/uitest-mobile.js [fichier.gpx] # test d'interface mobile (viewport iPhone, gestes)
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
| `js/ui-common.js` | fonctions partagées par les deux interfaces (mise en forme, statistiques, export) |
| `js/app.js` | interface bureau |
| `js/app-mobile.js` | interface smartphone |

Les fichiers `sample/sample-ride.gpx` (mise en forme Garmin Connect) et
`sample/sample-ride-strava.gpx` (mise en forme Strava : préfixe `gpxtpx:`, `<power>` en
enfant direct de `<extensions>`, deux `<trkseg>`) sont des enregistrements **synthétiques**
générés par `tools/make-sample.js` : aucune trace GPS personnelle n'est versionnée ici.
Les tests couvrent aussi le cas minimal (ni altitude ni extensions).
