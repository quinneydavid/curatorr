import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// playlist-artwork.js reads DATA_DIR at module load, so set it before importing.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curatorr-watch-folder-'));
process.env.DATA_DIR = path.join(testDir, 'data');

const {
  initDb,
  listPlaylistWatchFiles,
  listUserGeneratedPlaylists,
  getPlaylistTracks,
  refreshMasterTracks,
} = await import('../db.js');
const { registerApiMusic } = await import('../routes/api-music.js');
const { createPlaylistService } = await import('../services/playlists.js');
const { listPlaylistWatchCandidates } = await import('../services/playlist-watch-folder.js');

const OWNER = 'watch-owner';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48]);

let tick = 0;
// Writes a file with an mtime in the past so the scan does not treat it as still being written.
function writeSettled(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  tick += 1;
  const when = new Date(Date.now() - 60_000 + tick * 1000);
  fs.utimesSync(filePath, when, when);
}

function m3u(...titles) {
  return ['#EXTM3U', ...titles.flatMap((title) => [`#EXTINF:180,Watch Artist - ${title}`, `/elsewhere/${title}.flac`])].join('\n');
}

describe('playlist watch folder candidates', () => {
  it('pairs playlists with same-name artwork and skips other files', () => {
    const root = fs.mkdtempSync(path.join(testDir, 'candidates-'));
    writeSettled(path.join(root, 'Mix A.m3u8'), m3u('One'));
    writeSettled(path.join(root, 'mix a.JPG'), JPEG);
    writeSettled(path.join(root, 'Mix B.m3u'), m3u('One'));
    writeSettled(path.join(root, 'Mix B.m3u8.tmp'), m3u('One'));
    writeSettled(path.join(root, '.hidden.m3u8'), m3u('One'));
    writeSettled(path.join(root, 'notes.txt'), 'hello');
    writeSettled(path.join(root, 'Decades', '1980s.m3u8'), m3u('One'));
    writeSettled(path.join(root, 'Decades', '1980s.webp'), JPEG);

    const candidates = listPlaylistWatchCandidates(root);
    assert.deepEqual(candidates.map((entry) => entry.relPath), ['Decades/1980s.m3u8', 'Mix A.m3u8', 'Mix B.m3u']);
    assert.equal(path.basename(candidates[0].artworkPath), '1980s.webp');
    assert.equal(path.basename(candidates[1].artworkPath), 'mix a.JPG');
    assert.equal(candidates[2].artworkPath, '');
  });
});

describe('playlist watch folder scan', () => {
  let db;
  let dbPath;
  let watchDir;
  let config;
  let ctx;
  let app;
  let plexCalls;
  const originalFetch = global.fetch;

  before(() => {
    global.fetch = async (url, options = {}) => {
      const method = String(options.method || 'GET').toUpperCase();
      plexCalls.push({ url: String(url), method });
      if (method === 'POST' && String(url).includes('/playlists?')) {
        return Response.json({ MediaContainer: { Metadata: [{ ratingKey: 'plex-watch-1' }] } });
      }
      return Response.json({ MediaContainer: { size: 0, Metadata: [] } });
    };
  });

  after(() => {
    global.fetch = originalFetch;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    plexCalls = [];
    dbPath = path.join(testDir, `watch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = initDb(dbPath);
    watchDir = fs.mkdtempSync(path.join(testDir, 'watch-'));
    config = {
      mediaServer: { type: 'plex' },
      plex: { url: 'http://plex.local', token: 'admin-token', machineId: 'machine-watch', userServerTokens: { [OWNER]: 'owner-token' } },
      smartPlaylist: {},
      playlistWatchFolder: { enabled: true, path: watchDir, ownerUserId: OWNER, audience: 'personal', removeMissing: false },
    };
    ctx = {
      db,
      requireUser(req, _res, next) {
        req.session = { user: { username: OWNER, role: 'user', source: 'plex' } };
        next();
      },
      requireAdmin(_req, res) { res.status(403).json({ error: 'Admin access required.' }); },
      loadConfig: () => config,
      saveConfig() {},
      pushLog() {},
      safeMessage: (err) => String(err?.message || err || ''),
      getPreviewUserId: () => '',
      resolveUserPlexServerToken: () => 'owner-token',
      buildAppApiUrl: (base, rel) => new URL(String(rel || '').replace(/^\/+/, '/'), `${String(base || '').replace(/\/+$/, '')}/`),
      buildPlexAuthHeaders: (token, extra = {}) => ({ ...extra, 'X-Plex-Token': String(token || '') }),
      userHasOwnPlexToken: () => true,
      resolveLocalUsers: () => [],
      normalizeStoredAvatarPath: (value) => String(value || ''),
    };
    ctx.playlistService = createPlaylistService(ctx);
    app = express();
    app.use(express.json());
    registerApiMusic(app, ctx);
    refreshMasterTracks(db, ['One', 'Two', 'Three'].map((title, index) => ({
      ratingKey: `wk-${index + 1}`,
      artistName: 'Watch Artist',
      trackTitle: title,
      albumName: 'Watch Album',
      libraryKey: '1',
      filePath: `/music/watch/${title}.flac`,
      durationMs: 180000,
    })));
  });

  afterEach(() => {
    try { db.close(); } catch (_) {}
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  });

  function ownerPlaylists() {
    return listUserGeneratedPlaylists(db, OWNER, { activeOnly: false }).filter((entry) => entry.sourceType === 'm3u-watch');
  }

  it('imports new files with artwork, skips unchanged ones, and refreshes edited ones', async () => {
    writeSettled(path.join(watchDir, 'TIDAL Essentials - Sade.m3u8'), m3u('One', 'Missing Song'));
    writeSettled(path.join(watchDir, 'TIDAL Essentials - Sade.jpg'), JPEG);

    const first = await ctx.scanPlaylistWatchFolder();
    assert.equal(first.imported, 1, first.message);
    let [playlist] = ownerPlaylists();
    assert.equal(playlist.playlistTitle, 'TIDAL Essentials - Sade');
    assert.equal(playlist.sourceRef, 'm3u-watch:TIDAL Essentials - Sade.m3u8');
    assert.equal(playlist.trackCount, 1);
    assert.equal(playlist.missingCount, 1);
    assert.equal(playlist.artworkMode, 'custom');
    assert.match(playlist.customArtworkAsset, /^watch-/);
    const firstArtwork = playlist.customArtworkAsset;

    plexCalls = [];
    const second = await ctx.scanPlaylistWatchFolder();
    assert.equal(second.unchanged, 1, second.message);
    assert.equal(plexCalls.length, 0, 'an unchanged folder makes no media-server calls');

    writeSettled(path.join(watchDir, 'TIDAL Essentials - Sade.m3u8'), m3u('Two', 'One', 'Three'));
    const third = await ctx.scanPlaylistWatchFolder();
    assert.equal(third.updated, 1, third.message);
    assert.equal(ownerPlaylists().length, 1, 'an edited file refreshes the same playlist');
    assert.deepEqual(getPlaylistTracks(db, OWNER, playlist.playlistKey).map((track) => track.ratingKey), ['wk-2', 'wk-1', 'wk-3']);

    writeSettled(path.join(watchDir, 'TIDAL Essentials - Sade.jpg'), PNG);
    const fourth = await ctx.scanPlaylistWatchFolder();
    assert.equal(fourth.updated, 1, fourth.message);
    [playlist] = ownerPlaylists();
    assert.notEqual(playlist.customArtworkAsset, firstArtwork);
    assert.match(playlist.customArtworkAsset, /\.png$/);

    fs.rmSync(path.join(watchDir, 'TIDAL Essentials - Sade.jpg'));
    await ctx.scanPlaylistWatchFolder();
    [playlist] = ownerPlaylists();
    assert.equal(playlist.artworkMode, 'auto', 'removing the image reverts to automatic artwork');
  });

  it('keeps a playlist whose file is removed, or deletes it when removal is on', async () => {
    writeSettled(path.join(watchDir, 'Keep.m3u8'), m3u('One'));
    writeSettled(path.join(watchDir, 'Remove.m3u8'), m3u('Two'));
    await ctx.scanPlaylistWatchFolder();
    assert.equal(ownerPlaylists().length, 2);

    fs.rmSync(path.join(watchDir, 'Keep.m3u8'));
    const missing = await ctx.scanPlaylistWatchFolder();
    assert.equal(missing.missing, 1, missing.message);
    assert.equal(ownerPlaylists().length, 2);
    assert.equal(listPlaylistWatchFiles(db).find((entry) => entry.relPath === 'Keep.m3u8').status, 'missing');

    config.playlistWatchFolder.removeMissing = true;
    fs.rmSync(path.join(watchDir, 'Remove.m3u8'));
    const removed = await ctx.scanPlaylistWatchFolder();
    assert.equal(removed.removed, 2, removed.message);
    assert.equal(ownerPlaylists().length, 0);
    assert.equal(listPlaylistWatchFiles(db).length, 0);
  });

  it('leaves a playlist deleted in Curatorr alone until its file changes', async () => {
    writeSettled(path.join(watchDir, 'Gone.m3u8'), m3u('One'));
    await ctx.scanPlaylistWatchFolder();
    const [playlist] = ownerPlaylists();
    await request(app).delete('/api/music/playlists/generated').send({ playlistKey: playlist.playlistKey }).expect(200);

    await ctx.scanPlaylistWatchFolder();
    assert.equal(ownerPlaylists().length, 0);
    assert.equal(listPlaylistWatchFiles(db)[0].status, 'deleted');

    writeSettled(path.join(watchDir, 'Gone.m3u8'), m3u('One', 'Two'));
    const reimported = await ctx.scanPlaylistWatchFolder();
    assert.equal(reimported.imported, 1, reimported.message);
    assert.equal(ownerPlaylists().length, 1);
  });

  it('skips files that are still being written and reports oversized files', async () => {
    fs.writeFileSync(path.join(watchDir, 'Fresh.m3u8'), m3u('One'));
    writeSettled(path.join(watchDir, 'Huge.m3u8'), `#EXTM3U\n${'#'.repeat(2 * 1024 * 1024 + 1)}`);
    const result = await ctx.scanPlaylistWatchFolder();
    assert.equal(result.pending, 1, result.message);
    assert.equal(result.error, 1, result.message);
    assert.equal(ownerPlaylists().length, 0);
    assert.match(listPlaylistWatchFiles(db).find((entry) => entry.relPath === 'Huge.m3u8').message, /2 MB/);
  });

  it('re-reads the watched file on a manual refresh', async () => {
    writeSettled(path.join(watchDir, 'Manual.m3u8'), m3u('One'));
    await ctx.scanPlaylistWatchFolder();
    const [playlist] = ownerPlaylists();
    writeSettled(path.join(watchDir, 'Manual.m3u8'), m3u('One', 'Two'));

    const res = await request(app).post('/api/music/playlists/imported-refresh').send({ playlistKey: playlist.playlistKey }).expect(200);
    assert.equal(res.body.trackCount, 2);
    assert.match(ownerPlaylists()[0].sourceContent, /Two/);
  });

  it('marks playlists global when configured', async () => {
    config.playlistWatchFolder.audience = 'global';
    writeSettled(path.join(watchDir, 'Shared.m3u8'), m3u('One'));
    await ctx.scanPlaylistWatchFolder();
    assert.equal(ownerPlaylists()[0].audience, 'global');
  });

  it('does nothing while disabled and rejects a missing folder', async () => {
    config.playlistWatchFolder.enabled = false;
    assert.equal((await ctx.scanPlaylistWatchFolder()).skipped, true);
    config.playlistWatchFolder = { ...config.playlistWatchFolder, enabled: true, path: path.join(watchDir, 'nope') };
    await assert.rejects(() => ctx.scanPlaylistWatchFolder(), /not found/);
  });
});
