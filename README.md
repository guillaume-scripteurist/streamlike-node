# @scripteurist/streamlike-node

SDK **serveur** pour Streamlike et l'upload sécurisé Mediatech. Node ≥ 18, aucune
dépendance d'exécution.

> ⚠️ **Côté serveur uniquement.** Ce package détient le jeton d'API Streamlike.
> Il ne doit jamais être embarqué dans un bundle navigateur.

## Installation

Pas encore publié sur npm — la dépendance passe par l'URL git :

```jsonc
// package.json
"dependencies": {
  "@scripteurist/streamlike-node": "git+ssh://git@github.com/guillaume-scripteurist/streamlike-node.git#v0.4.1"
}
```

`dist/` n'est pas versionné : npm lance le script `prepare` après le clone, qui
construit le paquet. Rien à faire de plus.

## Ce qu'il contient

| Classe / module | Rôle |
| --- | --- |
| `StreamlikeClient` | **Écriture.** Médias (`createMedia` depuis une URL, `uploadMedia` en multipart, `getMedia`, `setMediaVisibility`), playlists, vues d'organisation, tags, pistes audio, jetons de lecture, sondage d'encodage. |
| `StreamlikeWebservices` | **Lecture.** Les 15 services `/ws/*` : playlists, médias, similaires, reprise, lectures en cours, votes, langues, pays. Réponses aplaties et typées. |
| `MediatechUploadClient` | `signUpload` / `completeUpload` / `refreshDownloadUrl` — fabrique le « ticket » que le navigateur utilise pour pousser ses octets vers GCS. |
| `StreamlikeAnalytics` | Les chiffres de la console : lectures, engagement, géographie, matériel, consommation, facturable. `isEmptyReport()` pour ne pas jeter sur une période vide. |
| `playability` / `isEmbeddable` | Ce média se lira-t-il dans une iframe nue ? Se tranche sur les drapeaux déjà présents dans la liste, sans appel supplémentaire. |
| `parseManifest` / `fetchStreams` | Du manifeste au **master HLS**, pour un player natif. |
| `playbackBeaconUrl` / `engagementBeaconUrl` | Les balises `o.k` et `eng.k`, à tirer quand on ne joue PAS avec le player Streamlike. |
| `rssUrl`, `podcastUrl`, `videoSitemapUrl`, `qrUrl` | Flux et emballages. |

## Deux portes, et une seule bonne réponse par besoin

```
LIRE  un catalogue, une fiche, une vignette
      → StreamlikeWebservices  (cdn.streamlike.com/ws/*)
        cachable, rapide, fait pour ça

ÉCRIRE un média, une playlist, une visibilité, un jeton
      → StreamlikeClient       (api.streamlike.com)
        jamais sur le chemin d'un affichage de page
```

C'est la distinction la plus coûteuse à rater de tout le projet. L'API REST
n'est pas dimensionnée pour une lecture par affichage de page, et la plateforme
**bride** les comptes qui s'en servent ainsi. Avant la 0.4.0 cette lib n'offrait
que l'API : lire un catalogue passait forcément par la mauvaise porte.

```ts
const ws = new StreamlikeWebservices({ companyId: process.env.SL_COMPANY_ID });

const page = await ws.getPlaylist({ playlistId, offset: 0, limit: 20, encoded: true });
page.size;        // taille de la playlist ENTIÈRE, pour l'état « fin de liste »
page.nextOffset;  // null quand il n'y a plus rien — pas de page vide à demander

for await (const media of ws.iteratePlaylist({ playlistId, pageSize: 50 })) {
  media.durationSec;                 // secondes
  media.cover.thumbnailLargeUrl;
  media.statistics.ratingAverage;    // null si personne n'a voté
}
```

> ⚠️ `companyId` est **un secret** : il adresse tout le catalogue. Il reste sur
> le serveur. Seuls `/ws/media` et `/ws/rss` sont dispensés de contrôle de
> référent et n'en ont pas besoin — un front peut appeler ces deux-là, aucun autre.

## Deux voies de dépôt, et comment choisir

```
createMedia(sourceUrl)   Streamlike va CHERCHER le fichier à une URL publique.
                         La voie normale quand on a un stockage accessible.

uploadMedia(file)        On POUSSE le binaire en multipart.
                         La seule voie possible quand on n'a pas d'URL publique
                         à offrir — typiquement une borne posée dans une salle.
```

## Encodage

Les réglages étaient codés en dur : toute installation produisait des sous-titres
français, quelle que soit la langue parlée. Ils sont désormais réglables, avec
des défauts qui reproduisent l'ancien comportement.

```ts
const client = new StreamlikeClient({
  apiToken: process.env.STREAMLIKE_API_TOKEN!,
  encode: {
    speechToText: true,          // sous-titres automatiques
    speechToTextLanguage: 'en',  // langue PARLÉE dans la vidéo
    automaticTranslation: true,
    encodingPassthru: true,      // pas de ré-encodage si le format est déjà lisible
  },
});

// Surchargeable appel par appel :
await client.uploadMedia({ ...media, encode: { speechToTextLanguage: 'es' } });
```

## Retirer un média sans le détruire

```ts
await client.setMediaVisibility(mediaId, 'offline');
```

`PATCH /medias/:id` avec `{ visibility: { state } }` — la même clé que celle posée à la création.
Un média `offline` n'est plus diffusable mais reste entier : ses playlists, ses champs
personnalisés et son encodage l'attendent, et un `'online'` le rend tel qu'il était. C'est ce
qui permet d'offrir à quelqu'un un bouton « supprimer ma vidéo » sans transformer un geste
malheureux en perte définitive. `listMedias({ visibility: 'offline' })` les retrouve.

## Ce média va-t-il se lire ?

Un catalogue n'est jamais entièrement lisible. Les trois drapeaux arrivent déjà
dans la liste : la question se tranche **sans un seul appel de plus**.

```ts
import { playability, playableOnly } from '@scripteurist/streamlike-node';

playability(media);   // 'open' | 'password' | 'restricted' | 'token-required'
playableOnly(page.medias);                      // retire ce qui ne lira pas
playableOnly(page.medias, { withToken: true }); // …sauf si on sait signer un sltoken
```

Un média à jeton **et** à mot de passe se lit : le player réclame le mot de
passe lui-même. L'ordre des tests est ce qui évite de retirer du catalogue un
média qui se serait très bien lu.

## Un player qui n'est pas celui de Streamlike

Le player de la plateforme rapporte tout seul ; un player natif ne rapporte
**rien**. C'est la première cause de « la console dit que personne ne regarde
nos vidéos » — le trafic apparaît dans la consommation, les lectures nulle part.

```ts
const streams = await fetchStreams(media.manifestUrl!);
streams.hlsMaster;  // l'entrée dont globalbitrate vaut 0 — pas la première, pas la plus grosse

fetch(playbackBeaconUrl({ mediaId, streamType: 'hls', playerName: 'kiosk-mobile' }));  // 1× par lecture
fetch(engagementBeaconUrl({ mediaId, durationSec, streamType: 'hls', qualityHeight: 720,
                           playerName: 'kiosk-mobile', fromSec, toSec, userToken }));  // à chaque segment
```

## La clé à donner à ce package

Une clé d'API agit comme le compte qui l'a créée, **avec tous ses droits** —
sauf si elle a été restreinte (API 5.30 : bloc « Droits de la clé » du
back-office, ou `roles[]` sur `POST /me/keys`). Une clé par intégration, limitée
aux rôles qu'elle exerce, avec une date d'expiration. Une borne qui dépose des
vidéos n'a pas besoin de pouvoir supprimer le catalogue ; `GET /me` avec la clé
dit ce qu'elle peut réellement faire.

## Ce que la documentation officielle dit de travers

Ces comportements ont été vérifiés sur un compte réel. Ils sont la raison d'être
de ce package : chacun échoue **en silence** ou avec un message trompeur.

| Piège | Ce qui marche |
| --- | --- |
| `createMedia` documenté « in: query » | Corps **JSON**. En query : `INVALID_FORM` / `UNKNOWN_FIELDS`. |
| Champ fichier `source[media_file]` | `source[encode][media_file]`. L'autre vaut `UNKNOWN_FIELDS`. |
| `resource` appendé en `Blob` | Appendre en **chaîne** : un Blob ajoute un `filename` et l'API prend le champ pour un fichier. |
| Playlists d'une vue en tableau d'ids | `[{id, position}]`. Sans `position` : `MANDATORY_PLAYLIST_POSITION`. |
| `fields=a,b` | `fields[]=a&fields[]=b`. Sinon `INVALID_FIELDS`. |
| Relire juste après avoir écrit | L'API met une à trois secondes à refléter une écriture. Ne pas en conclure que l'écriture a été ignorée. |
| Un 429 ressemble à une panne passagère | C'est un **plafond de débit**. Mediatech plafonne les URL d'upload signées **par compte et par heure** : le refus concerne tout le compte, pas l'appel. `ApiError.isRateLimited` et `retryAfterSeconds` (secondes **ou** date HTTP) le distinguent — réessayer aussitôt creuse le trou. |
| Le ticket d'upload se redemande à chaque essai | Chaque signature consomme le quota horaire du COMPTE. Conserver le ticket tant qu'il est valable est la seule façon de tenir un réessai — et ça garde le même `blob_path`, donc la reprise possible. |
| `/ws/*` : `page` ressemble à un numéro de page | C'est un **décalage**. `pagesize=10&page=10` rend les éléments 10 à 19. Cette lib expose `offset`/`limit` et traduit. |
| `/ws/*` : `sortorder=desc` | `up` / `down`. `desc` répond **404**. Les deux vocabulaires sont acceptés ici et traduits. |
| `/ws/*` : une erreur est du JSON | Une erreur est un **404 en HTML** — identifiant inconnu, valeur de paramètre invalide ou IP non autorisée, sans distinction. `WebserviceError` porte l'indice. |
| `/ws/qr` rend une image | Il rend une balise `<img>`. `fetchQrImageUrl()` en extrait le PNG. |
| Le premier flux du manifeste est le bon | Le master adaptatif est celui dont `globalbitrate` vaut **0**. Les autres sont des rendus isolés. |
| Plusieurs playlists : `a\|b` partout | `|` ne vaut que pour `videositemap`. `/ws/playlist` veut `playlist_id[]` répété. |
| `forceplaylist` garde l'ordre de la playlist | Il garde **les médias classés dans au moins une playlist**, rien d'autre. Et avant les webservices 5.20, `1` le COUPAIT : cette lib l'envoie en `true`/`false`, stables des deux côtés. |
| `encoding_version` absent = encodeur historique | Absent = **le média ne publie rien** (jamais encodé, live, premier encodage en cours). `WsMedia.encodingVersion` rend `null`, pas `1`. |
| Un 401 = clé morte | Pendant une fenêtre de maintenance, les ÉCRITURES répondent `401 API_OFFLINE` et les lectures passent (API 5.30). `ApiError.isOffline` : garder la file, rejouer plus tard — tout autre 401 est bien une clé morte. |
| Un rapport d'analyse vide est `{}` | C'est `[]`. `data[companyId]` jette ; `isEmptyReport()` teste les deux formes. |
| `duration_total` du facturable est en secondes | En **heures pondérées** depuis l'API 5.30, l'unité de `catalog_limit`. Les durées brutes à côté restent en secondes. |
| `source.is_cold_archived` se lit dans la fiche | Servi **seulement** sur `GET /medias/{id}` avec `fields[]=source.is_cold_archived` (API 5.31). `isColdArchived()` fait l'appel ; à poser avant tout ré-encodage, duplication ou export — la restauration prend 3 à 5 h. |

Champs personnalisés : les noms sont normalisés en minuscules, parce que
Streamlike les traite ainsi — un `Duree` créé à la main dans le back-office doit
être relu comme le `duree` qu'on écrit.

## Développement

```bash
npm install
npm run build
npm test        # construit puis lance les tests (aucun appel réseau)
npm run typecheck
```

Pour éditer ce package depuis un projet qui le consomme, sans passer par un
commit à chaque essai :

```bash
cd streamlike-node && npm link
cd ../mon-projet   && npm link @scripteurist/streamlike-node
```

## Licence

UNLICENSED — usage interne.
