const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_NAME = 'album_auth';
const SESSION_SECRET = process.env.SESSION_SECRET || 'local-dev-session-secret';
const SHARED_PASSWORD = process.env.SHARED_PASSWORD || 'album';
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE || 500 * 1024 * 1024);
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'tour-album-uploads');

const usePostgres = Boolean(process.env.DATABASE_URL);
const useR2 = Boolean(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_BUCKET &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
);

if (process.env.NODE_ENV === 'production' && !process.env.SHARED_PASSWORD) {
  throw new Error('SHARED_PASSWORD must be set in production.');
}

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
if (!useR2) {
  ['uploads', 'thumbnails'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

app.use(express.json());

const upload = multer({
  dest: TEMP_UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_SIZE },
});

const r2Client = useR2
  ? new S3Client({
      region: 'auto',
      endpoint:
        process.env.R2_ENDPOINT ||
        `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

const db = createDatabase();

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function createSessionToken() {
  const payload = 'tour-album';
  return `${payload}.${sign(payload)}`;
}

function isValidSessionToken(token) {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (signature.length !== expected.length) return false;
  return (
    payload === 'tour-album' &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}

function parseCookies(header) {
  return Object.fromEntries(
    (header || '')
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const index = part.indexOf('=');
        return index === -1
          ? [part, '']
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (isValidSessionToken(cookies[COOKIE_NAME])) return next();
  res.status(401).json({ error: '请先输入访问密码' });
}

function setAuthCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(createSessionToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

app.post('/api/login', (req, res) => {
  if (req.body?.password !== SHARED_PASSWORD) {
    return res.status(401).json({ error: '密码不正确' });
  }
  setAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  res.json({ authenticated: isValidSessionToken(cookies[COOKIE_NAME]) });
});

app.use(express.static('public'));
if (!useR2) app.use('/thumbnails', express.static('thumbnails'));

app.get('/api/files', requireAuth, async (req, res) => {
  const files = await db.listFiles();
  res.json(files.map(fileToResponse));
});

app.post(
  '/api/upload',
  requireAuth,
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  async (req, res) => {
    const tempPaths = [];
    try {
      const file = req.files?.file?.[0];
      if (!file) return res.status(400).json({ error: '未收到文件' });
      tempPaths.push(file.path);

      const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
      const type = file.mimetype.startsWith('video/') ? 'video' : 'photo';
      const fileId = uuidv4();
      const originalName = file.originalname;
      const ext = path.extname(originalName);
      const originalKey = `uploads/${fileId}${ext}`;
      const thumbKey = `thumbnails/${fileId}.jpg`;
      let thumbnailPath = null;

      if (type === 'photo') {
        const thumbnailBuffer = await sharp(file.path)
          .resize(400, 400, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toBuffer();
        await saveBuffer(thumbnailBuffer, thumbKey, 'image/jpeg');
        thumbnailPath = thumbKey;
      } else {
        const coverFile = req.files?.cover?.[0];
        if (coverFile) {
          tempPaths.push(coverFile.path);
          const coverBuffer = await fs.promises.readFile(coverFile.path);
          await saveBuffer(coverBuffer, thumbKey, 'image/jpeg');
          thumbnailPath = thumbKey;
        }
      }

      await saveFile(file.path, originalKey, file.mimetype);

      const savedFile = {
        id: fileId,
        originalName,
        mimeType: file.mimetype,
        filePath: originalKey,
        thumbnailPath,
        size: file.size,
        type,
        shootingTime: metadata.shootingTime || null,
        device: metadata.device || null,
        duration: metadata.duration || null,
        uploadedAt: new Date().toISOString(),
      };

      await db.insertFile(savedFile);
      res.json(fileToResponse(savedFile));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '上传处理失败' });
    } finally {
      await Promise.all(tempPaths.map(deleteLocalFile));
    }
  }
);

app.get('/api/files/:id/original', requireAuth, async (req, res) => {
  const file = await db.getFile(req.params.id);
  if (!file) return res.status(404).send('文件不存在');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
  res.setHeader('Content-Type', file.mimeType);
  await sendStoredFile(res, file.filePath);
});

app.get('/api/files/:id/thumbnail', requireAuth, async (req, res) => {
  const file = await db.getFile(req.params.id);
  if (!file?.thumbnailPath) return res.status(404).send('缩略图不存在');
  res.setHeader('Content-Type', 'image/jpeg');
  await sendStoredFile(res, file.thumbnailPath);
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const file = await db.getFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });

  await deleteStoredFile(file.filePath);
  if (file.thumbnailPath) await deleteStoredFile(file.thumbnailPath);
  await db.deleteFile(req.params.id);

  res.json({ success: true });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await db.init();
  app.listen(PORT, () => {
    console.log(`共享相册服务已启动: http://localhost:${PORT}`);
    console.log(`数据库: ${usePostgres ? 'PostgreSQL' : 'SQLite'}`);
    console.log(`文件存储: ${useR2 ? 'Cloudflare R2' : 'local filesystem'}`);
  });
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});

function fileToResponse(file) {
  return {
    id: file.id,
    originalName: file.originalName,
    type: file.type,
    size: Number(file.size),
    shootingTime: file.shootingTime,
    device: file.device,
    duration: file.duration,
    thumbnailUrl: file.thumbnailPath ? `/api/files/${file.id}/thumbnail` : null,
    originalUrl: `/api/files/${file.id}/original`,
    uploadedAt: file.uploadedAt,
  };
}

async function saveFile(sourcePath, key, contentType) {
  if (useR2) {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: fs.createReadStream(sourcePath),
        ContentType: contentType,
      })
    );
    return;
  }

  const targetPath = path.join(__dirname, key);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, targetPath);
}

async function saveBuffer(buffer, key, contentType) {
  if (useR2) {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
    return;
  }

  const targetPath = path.join(__dirname, key);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, buffer);
}

async function sendStoredFile(res, key) {
  if (useR2) {
    const object = await r2Client.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      })
    );
    object.Body.pipe(res);
    return;
  }

  res.sendFile(path.resolve(key));
}

async function deleteStoredFile(key) {
  if (useR2) {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      })
    );
    return;
  }

  await deleteLocalFile(path.resolve(key));
}

async function deleteLocalFile(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function createDatabase() {
  if (usePostgres) return createPostgresDatabase();
  return createSqliteDatabase();
}

function createSqliteDatabase() {
  const sqlite = new Database('album.db');
  return {
    async init() {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          originalName TEXT,
          mimeType TEXT,
          filePath TEXT,
          thumbnailPath TEXT,
          size INTEGER,
          type TEXT,
          shootingTime TEXT,
          device TEXT,
          duration TEXT,
          uploadedAt TEXT
        )
      `);
    },
    async listFiles() {
      return sqlite.prepare('SELECT * FROM files ORDER BY uploadedAt DESC').all();
    },
    async getFile(id) {
      return sqlite.prepare('SELECT * FROM files WHERE id = ?').get(id);
    },
    async insertFile(file) {
      sqlite
        .prepare(
          `INSERT INTO files (id, originalName, mimeType, filePath, thumbnailPath, size, type, shootingTime, device, duration, uploadedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          file.id,
          file.originalName,
          file.mimeType,
          file.filePath,
          file.thumbnailPath,
          file.size,
          file.type,
          file.shootingTime,
          file.device,
          file.duration,
          file.uploadedAt
        );
    },
    async deleteFile(id) {
      sqlite.prepare('DELETE FROM files WHERE id = ?').run(id);
    },
  };
}

function createPostgresDatabase() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          original_name TEXT,
          mime_type TEXT,
          file_path TEXT,
          thumbnail_path TEXT,
          size BIGINT,
          type TEXT,
          shooting_time TEXT,
          device TEXT,
          duration TEXT,
          uploaded_at TIMESTAMPTZ
        )
      `);
    },
    async listFiles() {
      const result = await pool.query('SELECT * FROM files ORDER BY uploaded_at DESC');
      return result.rows.map(rowToFile);
    },
    async getFile(id) {
      const result = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
      return result.rows[0] ? rowToFile(result.rows[0]) : null;
    },
    async insertFile(file) {
      await pool.query(
        `INSERT INTO files (id, original_name, mime_type, file_path, thumbnail_path, size, type, shooting_time, device, duration, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          file.id,
          file.originalName,
          file.mimeType,
          file.filePath,
          file.thumbnailPath,
          file.size,
          file.type,
          file.shootingTime,
          file.device,
          file.duration,
          file.uploadedAt,
        ]
      );
    },
    async deleteFile(id) {
      await pool.query('DELETE FROM files WHERE id = $1', [id]);
    },
  };
}

function rowToFile(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    filePath: row.file_path,
    thumbnailPath: row.thumbnail_path,
    size: row.size,
    type: row.type,
    shootingTime: row.shooting_time,
    device: row.device,
    duration: row.duration,
    uploadedAt: row.uploaded_at instanceof Date ? row.uploaded_at.toISOString() : row.uploaded_at,
  };
}
