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
  "@scripteurist/streamlike-node": "git+ssh://git@github.com/guillaume-scripteurist/streamlike-node.git#v0.1.0"
}
```

`dist/` n'est pas versionné : npm lance le script `prepare` après le clone, qui
construit le paquet. Rien à faire de plus.

## Ce qu'il contient

| Classe | Rôle |
| --- | --- |
| `StreamlikeClient` | Médias (`createMedia` depuis une URL, `uploadMedia` en multipart, `getMedia`, `setMediaVisibility`), playlists, vues d'organisation, tags, jetons de lecture, sondage d'encodage. |
| `MediatechUploadClient` | `signUpload` / `completeUpload` / `refreshDownloadUrl` — fabrique le « ticket » que le navigateur utilise pour pousser ses octets vers GCS. |

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
