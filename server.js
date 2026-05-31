const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const app = express();
const PORT = 3000;

['uploads', 'thumbnails'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const db = new Database('album.db');
db.exec(`
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.use(express.static('public'));
app.use('/thumbnails', express.static('thumbnails'));

app.get('/api/files', (req, res) => {
  const files = db.prepare('SELECT * FROM files ORDER BY uploadedAt DESC').all();
  const result = files.map(f => ({
    id: f.id,
    originalName: f.originalName,
    type: f.type,
    size: f.size,
    shootingTime: f.shootingTime,
    device: f.device,
    duration: f.duration,
    thumbnailUrl: f.thumbnailPath ? `/thumbnails/${path.basename(f.thumbnailPath)}` : null,
    originalUrl: `/api/files/${f.id}/original`,
    uploadedAt: f.uploadedAt
  }));
  res.json(result);
});

app.post('/api/upload', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  try {
    const file = req.files['file']?.[0];
    if (!file) return res.status(400).json({ error: '未收到文件' });
    const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
    const type = file.mimetype.startsWith('video/') ? 'video' : 'photo';
    const fileId = uuidv4();
    const originalName = file.originalname;
    const size = file.size;
    const shootingTime = metadata.shootingTime || null;
    const device = metadata.device || null;
    const duration = metadata.duration || null;
    let thumbnailPath = null;

    if (type === 'photo') {
      const thumbFilename = fileId + '.jpg';
      const thumbFullPath = path.join('thumbnails', thumbFilename);
      await sharp(file.path).resize(400, 400, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(thumbFullPath);
      thumbnailPath = thumbFullPath;
    } else {
      const coverFile = req.files['cover']?.[0];
      if (coverFile) {
        const thumbFilename = fileId + '.jpg';
        const thumbFullPath = path.join('thumbnails', thumbFilename);
        fs.copyFileSync(coverFile.path, thumbFullPath);
        fs.unlinkSync(coverFile.path);
        thumbnailPath = thumbFullPath;
      }
    }

    const ext = path.extname(originalName);
    const newFilePath = path.join('uploads', fileId + ext);
    fs.renameSync(file.path, newFilePath);

    db.prepare(`INSERT INTO files (id, originalName, mimeType, filePath, thumbnailPath, size, type, shootingTime, device, duration, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fileId, originalName, file.mimetype, newFilePath, thumbnailPath, size, type, shootingTime, device, duration, new Date().toISOString());

    res.json({ id: fileId, originalName, type, size, shootingTime, device, duration, thumbnailUrl: thumbnailPath ? `/thumbnails/${path.basename(thumbnailPath)}` : null, originalUrl: `/api/files/${fileId}/original`, uploadedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '上传处理失败' });
  }
});

app.get('/api/files/:id/original', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).send('文件不存在');
  res.setHeader('Content-Disposition', `inline; filename="${file.originalName}"`);
  res.setHeader('Content-Type', file.mimeType);
  res.sendFile(path.resolve(file.filePath));
});

app.delete('/api/files/:id', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  try {
    if (fs.existsSync(file.filePath)) fs.unlinkSync(file.filePath);
    if (file.thumbnailPath && fs.existsSync(file.thumbnailPath)) fs.unlinkSync(file.thumbnailPath);
  } catch (e) {}
  db.prepare('DELETE FROM files WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`📸 共享相册服务已启动: http://localhost:${PORT}`);
});