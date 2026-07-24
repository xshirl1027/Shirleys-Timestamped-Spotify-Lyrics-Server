const express = require("express");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const DB_PATH = process.env.DB_PATH || "./lyrics-cache.sqlite";
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function createDatabase() {
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS lyrics_cache (
      spotifyTrackId TEXT PRIMARY KEY,
      artistName TEXT NOT NULL,
      albumName TEXT NOT NULL,
      songName TEXT NOT NULL,
      syncedLyricsString TEXT
    );
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_lyrics_cache_spotifyTrackId
    ON lyrics_cache (spotifyTrackId);
  `);

  return db;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function extractSyncedLyrics(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const syncedLyrics = payload.syncedLyrics ?? payload.syncedlyrics ?? null;
  if (!nonEmptyString(syncedLyrics)) {
    return null;
  }

  return syncedLyrics;
}

function hasNoLyrics(payload) {
  if (!payload || typeof payload !== "object") {
    return true;
  }

  const syncedLyrics = payload.syncedLyrics ?? payload.syncedlyrics ?? null;
  const plainLyrics = payload.plainLyrics ?? payload.plainlyrics ?? null;

  const hasSynced = nonEmptyString(syncedLyrics);
  const hasPlain = nonEmptyString(plainLyrics);

  return !hasSynced && !hasPlain;
}

async function fetchFromLrclib({ artistName, songName, albumName }) {
  const url = new URL("https://lrclib.net/api/get");
  url.searchParams.set("artist_name", artistName);
  url.searchParams.set("track_name", songName);
  url.searchParams.set("album_name", albumName);

  let response;
  try {
    response = await fetch(url);
  } catch {
    return { payload: null, failed: true };
  }

  if (!response.ok) {
    return { payload: null, failed: true };
  }

  try {
    const payload = await response.json();
    return { payload, failed: false };
  } catch {
    return { payload: null, failed: true };
  }
}

async function upsertLyrics(
  db,
  { spotifyTrackId, artistName, albumName, songName, syncedLyricsString },
) {
  await db.run(
    `
      INSERT INTO lyrics_cache (spotifyTrackId, artistName, albumName, songName, syncedLyricsString)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(spotifyTrackId) DO UPDATE SET
        artistName = excluded.artistName,
        albumName = excluded.albumName,
        songName = excluded.songName,
        syncedLyricsString = excluded.syncedLyricsString
    `,
    [spotifyTrackId, artistName, albumName, songName, syncedLyricsString],
  );
}

async function createServer() {
  const app = express();
  const db = await createDatabase();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/lyrics", async (req, res) => {
    const spotifyTrackId = String(req.query.spotifyTrackId || "").trim();
    const artistNames = String(req.query.artistNames || "").trim();
    const songName = String(req.query.songName || "").trim();
    const albumName = String(req.query.albumName || "").trim();

    if (!spotifyTrackId || !artistNames || !songName || !albumName) {
      return res.status(400).json({
        error:
          "Missing required query params: spotifyTrackId, artistNames, songName, albumName",
      });
    }

    try {
      const existing = await db.get(
        "SELECT syncedLyricsString FROM lyrics_cache WHERE spotifyTrackId = ?",
        [spotifyTrackId],
      );

      if (existing) {
        return res.json({
          syncedLyrics: existing.syncedLyricsString,
        });
      }

      const firstTry = await fetchFromLrclib({
        artistName: artistNames,
        songName,
        albumName,
      });

      const firstTrySynced = extractSyncedLyrics(firstTry.payload);
      if (firstTrySynced) {
        await upsertLyrics(db, {
          spotifyTrackId,
          artistName: artistNames,
          albumName,
          songName,
          syncedLyricsString: firstTrySynced,
        });

        return res.json({
          source: "lrclib",
          fallbackUsed: false,
          data: {
            spotifyTrackId,
            artistName: artistNames,
            albumName,
            songName,
            syncedLyricsString: firstTrySynced,
          },
        });
      }

      const firstTryHasNoLyrics = hasNoLyrics(firstTry.payload);
      const shouldTryFallbackArtist =
        artistNames.includes(",") && (firstTry.failed || firstTryHasNoLyrics);

      if (shouldTryFallbackArtist) {
        const firstArtist = artistNames.split(",")[0].trim();
        if (firstArtist) {
          const secondTry = await fetchFromLrclib({
            artistName: firstArtist,
            songName,
            albumName,
          });

          const secondTrySynced = extractSyncedLyrics(secondTry.payload);
          if (secondTrySynced) {
            await upsertLyrics(db, {
              spotifyTrackId,
              artistName: artistNames,
              albumName,
              songName,
              syncedLyricsString: secondTrySynced,
            });

            return res.json({
              source: "lrclib",
              fallbackUsed: true,
              data: {
                spotifyTrackId,
                artistName: artistNames,
                albumName,
                songName,
                syncedLyricsString: secondTrySynced,
              },
            });
          }
        }
      }

      return res.status(404).json({
        source: "lrclib",
        message: "No synced lyrics found",
      });
    } catch (error) {
      return res.status(500).json({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
  });
}

createServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
