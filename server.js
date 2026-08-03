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

  const tableInfo = await db.all("PRAGMA table_info(lyrics);");
  const hasLegacyIndexColumn = tableInfo.some(
    (column) => column.name === "index",
  );
  const hasOriginalLyricsEnglishColumn = tableInfo.some(
    (column) => column.name === "isOriginalLyricsEnglish",
  );
  const hasLanguageColumn = tableInfo.some(
    (column) => column.name === "language",
  );

  if (hasLegacyIndexColumn) {
    const hasLegacyOriginalLyricsEnglishColumn = tableInfo.some(
      (column) => column.name === "isOriginalLyricsEnglish",
    );
    const hasLegacyLanguageColumn = tableInfo.some(
      (column) => column.name === "language",
    );

    await db.exec("BEGIN TRANSACTION;");
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS lyrics_new (
          spotifyTrackId TEXT PRIMARY KEY,
          syncedlyricsstr TEXT NOT NULL,
          isRomanization INTEGER NOT NULL,
          syncedaltlyricsstr TEXT NOT NULL,
          isOriginalLyricsEnglish INTEGER NOT NULL DEFAULT 0,
          language TEXT
        );
      `);

      await db.exec(`
        INSERT OR REPLACE INTO lyrics_new (spotifyTrackId, syncedlyricsstr, isRomanization, syncedaltlyricsstr, isOriginalLyricsEnglish, language)
        SELECT spotifyTrackId, syncedlyricsstr, isRomanization, syncedaltlyricsstr, ${hasLegacyOriginalLyricsEnglishColumn ? "COALESCE(isOriginalLyricsEnglish, 0)" : "0"}, ${hasLegacyLanguageColumn ? "language" : "NULL"}
        FROM lyrics;
      `);

      await db.exec("DROP TABLE lyrics;");
      await db.exec("ALTER TABLE lyrics_new RENAME TO lyrics;");
      await db.exec("COMMIT;");
    } catch (error) {
      await db.exec("ROLLBACK;");
      throw error;
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS lyrics (
      spotifyTrackId TEXT PRIMARY KEY,
      syncedlyricsstr TEXT NOT NULL,
      isRomanization INTEGER NOT NULL,
      syncedaltlyricsstr TEXT NOT NULL,
      isOriginalLyricsEnglish INTEGER NOT NULL DEFAULT 0,
      language TEXT
    );
  `);

  if (
    !hasLegacyIndexColumn &&
    tableInfo.length > 0 &&
    !hasOriginalLyricsEnglishColumn
  ) {
    await db.exec(`
      ALTER TABLE lyrics
      ADD COLUMN isOriginalLyricsEnglish INTEGER NOT NULL DEFAULT 0;
    `);
  }

  if (!hasLegacyIndexColumn && tableInfo.length > 0 && !hasLanguageColumn) {
    await db.exec(`
      ALTER TABLE lyrics
      ADD COLUMN language TEXT;
    `);
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_lyrics_spotifyTrackId
    ON lyrics (spotifyTrackId);
  `);

  return db;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateLyricsPayload(lyrics) {
  if (!lyrics || typeof lyrics !== "object") {
    return "Request body must include a lyrics object";
  }

  if (!isNonEmptyString(lyrics.spotifyTrackId)) {
    return "lyrics.spotifyTrackId must be a non-empty string";
  }

  if (typeof lyrics.syncedlyricsstr !== "string") {
    return "lyrics.syncedlyricsstr must be a string";
  }

  if (typeof lyrics.isRomanization !== "boolean") {
    return "lyrics.isRomanization must be a boolean";
  }

  if (typeof lyrics.syncedaltlyricsstr !== "string") {
    return "lyrics.syncedaltlyricsstr must be a string";
  }

  if (typeof lyrics.isOriginalLyricsEnglish !== "boolean") {
    return "lyrics.isOriginalLyricsEnglish must be a boolean";
  }

  if (!(lyrics.language === null || typeof lyrics.language === "string")) {
    return "lyrics.language must be a string or null";
  }

  return null;
}

async function createServer() {
  const app = express();
  const db = await createDatabase();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/lyrics", async (req, res) => {
    const lyrics = req.body?.lyrics;
    const validationError = validateLyricsPayload(lyrics);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const spotifyTrackId = lyrics.spotifyTrackId.trim();

    try {
      const existing = await db.get(
        "SELECT spotifyTrackId FROM lyrics WHERE spotifyTrackId = ?",
        [spotifyTrackId],
      );

      if (existing) {
        return res.status(200).json({
          message: "Lyrics already exist for this spotifyTrackId",
          spotifyTrackId,
        });
      }

      await db.run(
        `
          INSERT INTO lyrics (spotifyTrackId, syncedlyricsstr, isRomanization, syncedaltlyricsstr, isOriginalLyricsEnglish, language)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          spotifyTrackId,
          lyrics.syncedlyricsstr,
          lyrics.isRomanization ? 1 : 0,
          lyrics.syncedaltlyricsstr,
          lyrics.isOriginalLyricsEnglish ? 1 : 0,
          lyrics.language,
        ],
      );

      return res.status(201).json({
        message: "Lyrics created",
        spotifyTrackId,
      });
    } catch (error) {
      return res.status(500).json({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/lyrics", async (req, res) => {
    const spotifyTrackId = String(
      req.query.spotifyTrackId ?? req.query.spotifytrackid ?? "",
    ).trim();

    if (!spotifyTrackId) {
      return res.status(400).json({
        error: "Missing required query param: spotifyTrackId",
      });
    }

    try {
      const row = await db.get(
        `
          SELECT spotifyTrackId, syncedlyricsstr, isRomanization, syncedaltlyricsstr, isOriginalLyricsEnglish, language
          FROM lyrics
          WHERE spotifyTrackId = ?
        `,
        [spotifyTrackId],
      );

      if (!row) {
        return res.status(404).json({
          error: "Lyrics not found",
        });
      }

      return res.status(200).json({
        spotifyTrackId: row.spotifyTrackId,
        syncedlyricsstr: row.syncedlyricsstr,
        isRomanization: Boolean(row.isRomanization),
        syncedaltlyricsstr: row.syncedaltlyricsstr,
        isOriginalLyricsEnglish: Boolean(row.isOriginalLyricsEnglish),
        language: row.language,
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
