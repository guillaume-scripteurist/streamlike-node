/**
 * Ce que Streamlike reçoit réellement quand on règle l'encodage.
 *
 * Ces options étaient codées en dur (`speech_to_text` en `fr`, `passthru` à 1) :
 * une borne installée hors de France produisait des sous-titres français sans
 * aucun recours. Le test vérifie donc les DEUX choses qui comptent :
 *
 *   1. les réglages arrivent bien dans la requête, dans la bonne notation à
 *      crochets (`source[encode][…]`) — c'est la seule forme que l'API accepte,
 *      et elle échoue en silence si on se trompe ;
 *   2. ne rien régler produit exactement la requête d'avant. C'est ce qui
 *      autorise la mise à jour d'un parc de bornes déjà posées.
 *
 * `fetch` est remplacé, aucun appel réseau n'est fait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StreamlikeClient } from '../dist/index.js';

/** Remplace `fetch` et retourne les champs du multipart du dernier appel. */
async function captureUpload(clientConfig, input = {}) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: options.body };
    return new Response(JSON.stringify({ id: '42', permalink: 'p' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const client = new StreamlikeClient({ apiToken: 'jeton-de-test', ...clientConfig });
    await client.uploadMedia({
      file: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }),
      filename: 'reponse.mp4',
      name: 'Marie — la question',
      permalink: 'kiosque-test',
      ...input,
    });
  } finally {
    globalThis.fetch = original;
  }
  // Un FormData ne se lit pas comme un objet : on rassemble les champs non
  // fichier, seuls concernés par les réglages d'encodage.
  const fields = {};
  for (const [key, value] of captured.body.entries()) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}

test('sans réglage, la requête est celle d\'avant les options', async () => {
  const fields = await captureUpload({});
  assert.equal(fields['source[encode][encoding_passthru]'], '1');
  assert.equal(fields['source[encode][speech_to_text][type]'], 'subtitle_transcript');
  assert.equal(fields['source[encode][speech_to_text][automatic_translation]'], 'true');
  assert.equal(fields['source[encode][speech_to_text][language]'], 'fr');
});

test('la langue parlée suit le réglage du client', async () => {
  const fields = await captureUpload({ encode: { speechToTextLanguage: 'en' } });
  assert.equal(fields['source[encode][speech_to_text][language]'], 'en');
});

test('sous-titres coupés : plus AUCUNE clé speech_to_text', async () => {
  const fields = await captureUpload({ encode: { speechToText: false } });
  const restes = Object.keys(fields).filter(k => k.includes('speech_to_text'));
  assert.deepEqual(restes, [], `clés restantes : ${restes.join(', ')}`);
  // Le passthru, lui, n'a aucune raison de disparaître avec les sous-titres.
  assert.equal(fields['source[encode][encoding_passthru]'], '1');
});

test('passthru coupé : la clé est absente, pas mise à 0', async () => {
  // L'API lit la présence du champ, pas sa valeur : envoyer `0` activerait
  // le passthru tout en donnant l'impression de l'avoir désactivé.
  const fields = await captureUpload({ encode: { encodingPassthru: false } });
  assert.equal('source[encode][encoding_passthru]' in fields, false);
});

test('le réglage de l\'appel prime sur celui du client', async () => {
  const fields = await captureUpload(
    { encode: { speechToTextLanguage: 'en', automaticTranslation: false } },
    { encode: { speechToTextLanguage: 'es' } },
  );
  assert.equal(fields['source[encode][speech_to_text][language]'], 'es');
  // Ce que l'appel ne dit pas reste au réglage du client.
  assert.equal(fields['source[encode][speech_to_text][automatic_translation]'], 'false');
});

test('createMedia sans transcription demandée n\'émet rien — comportement historique', async () => {
  const original = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (url, options) => {
    payload = JSON.parse(options.body);
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new StreamlikeClient({ apiToken: 'jeton-de-test' });
    await client.createMedia({ name: 'n', permalink: 'p', sourceUrl: 'https://exemple/v.mp4' });
  } finally {
    globalThis.fetch = original;
  }
  const clesEncode = Object.keys(payload).filter(k => k.startsWith('source[encode]'));
  assert.deepEqual(clesEncode, []);
});

test('createMedia : le raccourci historique `speechToText: "fr"` marche toujours', async () => {
  const original = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (url, options) => {
    payload = JSON.parse(options.body);
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new StreamlikeClient({ apiToken: 'jeton-de-test' });
    await client.createMedia({ name: 'n', permalink: 'p', speechToText: 'de' });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(payload['source[encode][speech_to_text][language]'], 'de');
  assert.equal(payload['source[encode][speech_to_text][type]'], 'subtitle_transcript');
});

/**
 * Un plafond de débit doit se distinguer d'une panne.
 *
 * Mediatech plafonne les URL d'upload signées **par compte et par heure**. Un
 * 429 concerne donc tout un événement, pas la personne qui l'a déclenché — et
 * un appelant qui le prend pour une erreur passagère réessaie aussitôt, se
 * refait refuser, et creuse le trou.
 */
import { MediatechUploadClient, ApiError } from '../dist/index.js';

/** Remplace `fetch` par un refus 429 portant l'en-tête demandé. */
async function refuse(retryAfter) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ detail: 'Too many signed URLs.' }),
    {
      status: 429,
      headers: retryAfter == null
        ? { 'content-type': 'application/json' }
        : { 'content-type': 'application/json', 'retry-after': retryAfter },
    },
  );
  try {
    const client = new MediatechUploadClient({ apiToken: 'jeton', accountId: 'compte' });
    await client.signUpload({ filename: 'a.webm', callbackUrl: 'https://exemple.test/cb' });
    throw new Error('aurait dû être refusé');
  } catch (err) {
    return err;
  } finally {
    globalThis.fetch = original;
  }
}

test('un 429 est reconnu comme un plafond, pas comme une panne', async () => {
  const err = await refuse('120');
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 429);
  assert.equal(err.isRateLimited, true);
  assert.equal(err.retryAfterSeconds, 120);
});

test('Retry-After en date HTTP est lu aussi', async () => {
  // Ne gérer que la forme numérique produit un NaN silencieux, et l'appelant
  // réessaie immédiatement — exactement ce que le plafond cherche à éviter.
  const dans60s = new Date(Date.now() + 60_000).toUTCString();
  const err = await refuse(dans60s);
  assert.ok(err.retryAfterSeconds >= 55 && err.retryAfterSeconds <= 61,
    `attendu ~60, reçu ${err.retryAfterSeconds}`);
});

test('sans Retry-After, on ne devine pas de délai', async () => {
  const err = await refuse(null);
  assert.equal(err.isRateLimited, true);
  assert.equal(err.retryAfterSeconds, undefined);
});
