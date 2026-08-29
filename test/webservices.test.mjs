/**
 * Ce que les webservices reçoivent, et ce que la lib en fait.
 *
 * Trois choses seulement, mais ce sont celles qui coûtent une après-midi
 * chacune quand on les découvre en production :
 *
 *   1. `page` est un DÉCALAGE. Un `offset` de 20 doit partir en `page=20`,
 *      jamais en `page=2` — sinon la deuxième page d'un flux montre les
 *      éléments 2 à 11 et personne ne s'en aperçoit avant les doublons ;
 *   2. `sortorder` vaut `up`/`down`. `desc` répond 404, en HTML ;
 *   3. un 404 est une page HTML : le laisser filer jusqu'à `JSON.parse` donne
 *      « Unexpected token < », qui ne dit rien de la cause.
 *
 * `fetch` est remplacé, aucun appel réseau n'est fait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  StreamlikeWebservices,
  WebserviceError,
  playability,
  isEmbeddable,
  playableOnly,
  parseManifest,
  playbackBeaconUrl,
  engagementBeaconUrl,
  isReportableSegment,
  videoSitemapUrl,
  podcastUrl,
} from '../dist/index.js';

/** Un média minimal au format de la plateforme. */
function mediaJson(overrides = {}) {
  return {
    metadata: {
      global: {
        media_id: 'abc123', name: 'Marie', permalink: 'marie', type: 'video',
        duration: '137', ratio: '1.7778', is_tokenized: '0', has_password: '0',
        is_secured: '0', is_multiple_audio: '1', description: '',
        ...overrides,
      },
      share: { universal_url: 'https://exemple.test/marie' },
      customization: { cover: { thumbnaillarge_url: 'https://img.test/l.jpg' } },
      playlists: [{ playlist: { playlist_id: 'p1', name: 'Soirée', position: '2' } }],
      // Pas de clé `subtitles` : la plateforme OMET les blocs vides.
    },
    statistics: { media_access: '42', rating_hits: '4', rating_totalvalue: '18' },
    html5_sources: [{ html5_source: { type: 'streamlike_html5', manifest: '//cfcdn.test/m.json' } }],
  };
}

/** Remplace `fetch` et rend l'URL appelée. */
function withFetch(payload, { status = 200, contentType = 'application/json' } = {}) {
  const calls = [];
  const fake = async (url) => {
    calls.push(String(url));
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(body, { status, headers: { 'content-type': contentType } });
  };
  return { fake, calls };
}

test('page est un décalage, pas un numéro de page', async () => {
  const { fake, calls } = withFetch({ playlist: { metadata: { size: '100' }, medias: [] } });
  const ws = new StreamlikeWebservices({ fetch: fake });
  await ws.getPlaylist({ playlistId: 'p1', offset: 20, limit: 10 });
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('page'), '20');
  assert.equal(url.searchParams.get('pagesize'), '10');
});

test('sortorder traduit asc/desc en up/down', async () => {
  const { fake, calls } = withFetch({ playlist: { metadata: { size: '0' }, medias: [] } });
  const ws = new StreamlikeWebservices({ fetch: fake });
  await ws.getPlaylist({ playlistId: 'p1', sortOrder: 'desc', orderBy: 'creationdate' });
  assert.equal(new URL(calls[0]).searchParams.get('sortorder'), 'down');
});

test('plusieurs playlists partent en playlist_id[] répété', async () => {
  const { fake, calls } = withFetch({ playlist: { metadata: { size: '0' }, medias: [] } });
  const ws = new StreamlikeWebservices({ fetch: fake });
  await ws.getPlaylist({ playlistId: ['a', 'b'] });
  assert.equal(calls[0].match(/playlist_id%5B%5D=/g)?.length, 2);
});

test('un 404 HTML devient une WebserviceError qui explique', async () => {
  const { fake } = withFetch('<html><body>Not found</body></html>', { status: 404, contentType: 'text/html' });
  const ws = new StreamlikeWebservices({ fetch: fake, companyId: 'c1' });
  await assert.rejects(
    () => ws.vote({ mediaId: 'abc', value: 5 }),
    (err) => {
      assert.ok(err instanceof WebserviceError);
      assert.equal(err.status, 404);
      // `vote` ne peut pas être dispensé de liste blanche : c'est la première
      // piste à donner, pas « média introuvable ».
      assert.match(err.hint, /IP serveur autoris/);
      return true;
    },
  );
});

test('company_id manquant est refusé avant l\'appel réseau', async () => {
  const ws = new StreamlikeWebservices({ fetch: async () => { throw new Error('ne doit pas être appelé'); } });
  await assert.rejects(() => ws.listPlaylists(), /company_id manquant/);
});

test('un média est aplati, drapeaux « 0 » compris', async () => {
  const { fake } = withFetch({ media: mediaJson() });
  const ws = new StreamlikeWebservices({ fetch: fake });
  const media = await ws.getMedia({ mediaId: 'abc123' });

  assert.equal(media.id, 'abc123');
  assert.equal(media.durationSec, 137);
  assert.equal(media.ratio, 1.7778);
  // "0" est une chaîne non vide : un !! naïf masquerait tout le catalogue.
  assert.equal(media.isTokenized, false);
  assert.equal(media.isMultipleAudio, true);
  // Bloc absent -> tableau vide, pas undefined.
  assert.deepEqual(media.subtitles, []);
  assert.equal(media.playlists[0].id, 'p1');
  assert.equal(media.statistics.playbacks, 42);
  assert.equal(media.statistics.ratingAverage, 4.5);
  assert.equal(media.manifestUrl, '//cfcdn.test/m.json');
});

test('la pagination s\'arrête sur size, sans demander de page vide', async () => {
  let page = 0;
  const fake = async (url) => {
    const offset = Number(new URL(url).searchParams.get('page'));
    page += 1;
    const medias = offset < 3 ? [{ media: mediaJson({ media_id: `m${offset}` }) }] : [];
    return new Response(JSON.stringify({ playlist: { metadata: { size: '3' }, medias } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const ws = new StreamlikeWebservices({ fetch: fake });
  const all = [];
  for await (const media of ws.iteratePlaylist({ playlistId: 'p1', pageSize: 1 })) all.push(media.id);
  assert.deepEqual(all, ['m0', 'm1', 'm2']);
  // Trois pages, pas quatre : la quatrième aurait été un appel pour rien.
  assert.equal(page, 3);
});

test('la lisibilité se tranche sans appel supplémentaire', () => {
  assert.equal(playability({}), 'open');
  assert.equal(playability({ isTokenized: true }), 'token-required');
  // Jeton ET mot de passe : le player demande le mot de passe, ça se lit.
  assert.equal(playability({ isTokenized: true, hasPassword: true }), 'password');
  assert.equal(playability({ isSecured: true }), 'restricted');
  assert.equal(isEmbeddable({ isTokenized: true }), false);
  assert.equal(isEmbeddable({ isSecured: true }), true);

  const list = [{ id: 'a' }, { id: 'b', isTokenized: true }];
  assert.deepEqual(playableOnly(list).map(m => m.id), ['a']);
  assert.deepEqual(playableOnly(list, { withToken: true }).map(m => m.id), ['a', 'b']);
});

test('le master HLS se reconnaît à son débit nul', () => {
  const streams = parseManifest({
    idevicev2: [
      { globalbitrate: 320, width: 240, height: 176, url: '//cdn.test/240.m3u8' },
      { globalbitrate: 0, url: '//cdn.test/index.m3u8' },
      { globalbitrate: 1500, width: 1280, height: 720, url: '//cdn.test/720.m3u8' },
    ],
    mp4: [{ globalbitrate: 1408, url: '//cdn.test/x.mp4' }],
  });
  assert.equal(streams.hlsMaster, 'https://cdn.test/index.m3u8');
  assert.deepEqual(streams.hlsRenditions.map(r => r.bitrate), [320, 1500]);
  assert.equal(streams.progressive[0].url, 'https://cdn.test/x.mp4');
});

test('les balises d\'audience portent les bons paramètres', () => {
  const play = new URL(playbackBeaconUrl({ mediaId: 'abc', streamType: 'hls', playerName: 'kiosk', timestamp: 7 }));
  assert.equal(play.pathname, '/o.k');
  assert.equal(play.searchParams.get('m'), 'abc');
  assert.equal(play.searchParams.get('s'), 'hls');

  const eng = new URL(engagementBeaconUrl({
    mediaId: 'abc', durationSec: 100, streamType: 'hls', qualityHeight: 720,
    playerName: 'kiosk', fromSec: 10, toSec: 250, timestamp: 7,
  }));
  // `re` est borné par la durée : la plateforme rejette un segment hors durée,
  // et le rejet d'un GET dont personne ne lit la réponse est invisible.
  assert.equal(eng.searchParams.get('re'), '100');
  assert.equal(isReportableSegment(10, 10.2), false);
  assert.equal(isReportableSegment(10, 12), true);
});

test('le sitemap joint les playlists par | et le podcast ignore le reste', () => {
  assert.match(videoSitemapUrl({ playlistIds: ['a', 'b'] }), /playlist_id=a%7Cb/);
  const podcast = new URL(podcastUrl({ playlistId: 'p1', language: 'fr' }));
  assert.equal(podcast.searchParams.get('playlist_id'), 'p1');
  assert.equal(podcast.searchParams.get('pagesize'), null);
});
