const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const cors = require('cors');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const fs = require('fs');
const mysql = require('mysql2/promise');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const authRoutes = require('./routes/auth');
const itemRoutes = require('./routes/items');
const pairRoutes = require('./routes/pairs');
const activityRoutes = require('./routes/activity');
const analyticsRoutes = require('./routes/analytics');
const settingsRoutes = require('./routes/settings');
const overviewRoutes = require('./routes/overview');

const app = express();
const PORT = process.env.PORT || 4000;
const isProduction = process.env.NODE_ENV === 'production';

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'db_1800soles_stock_management',
  port: Number(process.env.DB_PORT || '3306')
};

async function ensureSchema() {
  const schemaPath = path.join(process.cwd(), 'database', 'schema.sql');
  if (!fs.existsSync(schemaPath)) return;

  const schema = fs.readFileSync(schemaPath, 'utf8');
  const conn = await mysql.createConnection({
    host: dbConfig.host,
    user: dbConfig.user,
    password: dbConfig.password,
    port: dbConfig.port,
    multipleStatements: true
  });

  await conn.query(schema);
  await conn.end();
}

if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

app.use(express.static(path.join(process.cwd(), 'frontend')));
app.use('/images', express.static(path.join(process.cwd(), 'images')));

app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

async function start() {
  try {
    await ensureSchema();
  } catch (err) {
    console.error('Failed to ensure DB schema:', err);
  }

  const sessionStore = new MySQLStore(dbConfig);
  const cookieMaxAge = Number(process.env.SESSION_COOKIE_MAX_AGE_MS || 1000 * 60 * 60 * 8);

  app.use(session({
    name: 'sessid',
    secret: process.env.SESSION_SECRET || 'secret',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: cookieMaxAge,
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax'
    }
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/items', itemRoutes);
  app.use('/api/pairs', pairRoutes);
  app.use('/api/activity', activityRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/overview', overviewRoutes);
  app.use('/api/settings', settingsRoutes);

  app.get('/', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'frontend', 'index.html'));
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();
