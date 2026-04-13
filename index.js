const express = require('express');
const app = express();
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const server = http.createServer(app);

const port = process.env.PORT || 5000;
const serverUrl = (process.env.SERVER_URL || `http://localhost:${port}`).replace(/\/$/, '');
const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const allowedOrigins = [
  frontendUrl, 
  'http://localhost:5173', 
  'https://pustregistration.netlify.app'
];

const io = new Server(server, {
  cors: { 
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'], 
    credentials: true 
  }
});

// CORS Configuration
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.error('CORS Blocked for origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Cookie'],
  exposedHeaders: ['Set-Cookie']
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Health Check
app.get('/health', (req, res) => res.status(200).send('OK'));

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const SSLCommerzPayment = require('sslcommerz-lts');
const crypto = require('crypto');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use OS temp directory for uploads to save RAM
const upload = multer({ dest: os.tmpdir() });
const ALGORITHM = 'aes-256-cbc';

if (!process.env.MASTER_KEY) {
  throw new Error('MASTER_KEY is required');
}
const MASTER_KEY = Buffer.from(process.env.MASTER_KEY);

const decrypt = (encryptedData, ivHex) => {
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

const encrypt = (text) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { encryptedData: encrypted, iv: iv.toString('hex') };
};

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key';
const verifyAdmin = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).send({ message: 'Unauthorized' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).send({ message: 'Invalid token' });
    req.admin = decoded;
    next();
  });
};

let cachedClient = null;
async function getDatabase() {
  if (!cachedClient) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverApi: { version: ServerApiVersion.v1 },
    });
    await client.connect();
    cachedClient = client;
  }
  return cachedClient.db('admission');
}

let cachedRules = null;
async function getRules(db) {
  if (!cachedRules) {
    cachedRules = await db.collection('eligibility_rules').find().toArray();
  }
  return cachedRules;
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// ===== Socket Handling =====
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('join-job', (jobId) => {
    console.log(`Socket ${socket.id} joining room: ${jobId}`);
    socket.join(jobId);
  });
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    socket.rooms.forEach(room => socket.leave(room));
  });
});

// Memory logging
setInterval(() => {
  const used = process.memoryUsage();
  console.log({
    rss: (used.rss / 1024 / 1024).toFixed(2) + " MB",
    heapUsed: (used.heapUsed / 1024 / 1024).toFixed(2) + " MB"
  });
}, 10000);

// ===== Helper for Eligibility Logic =====
const checkEligibility = (student, rules) => {
  const eligibleDepts = [];
  rules.forEach(dept => {
    let isEligible = true;
    if (student.hsc_gpa < dept.min_hsc_gpa) isEligible = false;
    if (student.ssc_gpa < dept.min_ssc_gpa) isEligible = false;
    if ((student.hsc_gpa + student.ssc_gpa) < dept.min_total_gpa) isEligible = false;
    if (isEligible && dept.required_subjects) {
      dept.required_subjects.forEach(sub => {
        const mark = student[sub] === '--' ? 0 : parseFloat(student[sub]);
        if (isNaN(mark) || mark <= 0) isEligible = false;
      });
    }
    if (isEligible && dept.min_math_mark && (parseFloat(student.MATH) < dept.min_math_mark)) isEligible = false;
    if (isEligible && dept.min_bio_mark && (parseFloat(student.BIO) < dept.min_bio_mark)) isEligible = false;
    if (isEligible && dept.min_english_mark && (parseFloat(student.ENG) < dept.min_english_mark)) isEligible = false;
    if (isEligible && dept.must_have_math) {
      const mathMark = parseFloat(student.MATH);
      if (isNaN(mathMark) || mathMark <= 0) isEligible = false;
    }
    if (isEligible) eligibleDepts.push(dept.code);
  });
  return eligibleDepts;
};

// ===== Background Jobs =====
const activeJobs = new Map();

// GST Upload Batch Route (Memory Safe)
app.post('/upload-gst-batch', verifyAdmin, async (req, res) => {
  try {
    const { items, jobId, isLast } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).send({ message: 'No items provided' });

    const db = await getDatabase();
    const ops = items.map(item => ({
      updateOne: { filter: { admission_roll: item.admission_roll }, update: { $set: item }, upsert: true }
    }));

    if (ops.length > 0) {
      await db.collection('gst_results').bulkWrite(ops);
    }

    if (isLast) {
      io.to(jobId).emit('completed');
    }
    
    res.send({ success: true });
  } catch (error) {
    console.error('Batch upload error:', error);
    res.status(500).send({ error: error.message });
  }
});

// GST Export Route (Disk Streaming)
app.get('/export-gst', verifyAdmin, async (req, res) => {
  try {
    const jobId = new ObjectId().toString();
    const tempFilePath = path.join(os.tmpdir(), `export_${jobId}.csv`);
    console.log('Starting export job:', jobId);
    res.send({ jobId });

    setImmediate(async () => {
      const writeStream = fs.createWriteStream(tempFilePath);
      try {
        const db = await getDatabase();
        const rules = await getRules(db);
        const cursor = db.collection('gst_results').find({}).sort({ "Merit Position": 1 });
        const total = await db.collection('gst_results').countDocuments();
        
        const startTime = Date.now();
        let count = 0;

        writeStream.write('Roll,Name,GST Total,Merit,Eligible_Codes\n');

        while (await cursor.hasNext()) {
          const student = await cursor.next();
          const codes = checkEligibility(student, rules);
          const name = `"${(student.name || '').replace(/"/g, '""')}"`;
          const formattedCodes = codes.map(c => String(c).trim().padStart(3, '0'));
          const eligibleCodes = `"${formattedCodes.join(',')}"`;
          
          const row = `${student.admission_roll},${name},${student.TOTAL || 0},${student['Merit Position'] || ''},${eligibleCodes}\n`;
          
          if (!writeStream.write(row)) {
            await new Promise(resolve => writeStream.once('drain', resolve));
          }
          
          count++;
          if (count % 1000 === 0 || count === total) {
            const progress = Math.round((count / total) * 100);
            const elapsedTime = (Date.now() - startTime) / 1000;
            const remainingTime = Math.round((elapsedTime / count) * (total - count));
            io.to(jobId).emit('progress', { progress, remainingTime, processed: count });
            await new Promise(r => setTimeout(r, 5));
          }
        }

        writeStream.end();
        writeStream.on('finish', () => {
          activeJobs.set(jobId, tempFilePath); // Store file path instead of buffer
          setTimeout(() => {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            activeJobs.delete(jobId);
          }, 5 * 60 * 1000);
          io.to(jobId).emit('export-ready', { downloadUrl: `${serverUrl}/download-export/${jobId}` });
        });
      } catch (err) {
        writeStream.end();
        console.error('Export job error:', err);
        io.to(jobId).emit('error', { message: err.message });
      }
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.get('/download-export/:jobId', (req, res) => {
  const filePath = activeJobs.get(req.params.jobId);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found or expired');
  }
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=gst_eligibility_results.csv');
  
  const readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
  
  readStream.on('close', () => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    activeJobs.delete(req.params.jobId);
  });
});

// Regular Routes
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = await getDatabase();
  const admin = await db.collection('admins').findOne({ username });
  if (admin && await bcrypt.compare(password, admin.password)) {
    const token = jwt.sign({ id: admin._id, username: admin.username }, JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', token, { 
      httpOnly: true, 
      sameSite: 'none', 
      secure: true, 
      maxAge: 7200000 
    }).send({ success: true });
  } else res.status(401).send({ success: false });
});

app.post('/logout', (req, res) => res.clearCookie('token').send({ success: true }));
app.get('/verify-session', verifyAdmin, (req, res) => res.send({ success: true, admin: req.admin }));

app.get('/gst-results', verifyAdmin, async (req, res) => {
  const { search, page = 1, limit = 21 } = req.query;
  const db = await getDatabase();
  let query = search ? { admission_roll: parseInt(search) } : {};
  const results = await db.collection('gst_results').find(query).sort({'Merit Position':1}).skip((page-1)*limit).limit(parseInt(limit)).toArray();
  const total = await db.collection('gst_results').countDocuments(query);
  res.send({ results, total, page, totalPages: Math.ceil(total/limit) });
});

app.delete('/gst-results', verifyAdmin, async (req, res) => {
  try {
    console.log('Initiating full deletion of GST results...');
    const db = await getDatabase();
    const result = await db.collection('gst_results').deleteMany({});
    console.log(`Deletion completed. Removed ${result.deletedCount} records.`);
    res.send({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).send({ error: error.message });
  }
});

app.get('/gst-results/:roll', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  const student = await db.collection('gst_results').findOne({ admission_roll: parseInt(req.params.roll) });
  if (!student) return res.status(404).send({ message: 'Not found' });
  const rules = await db.collection('eligibility_rules').find().toArray();
  const codes = checkEligibility(student, rules);
  const eligibleDepts = rules.filter(r => codes.includes(r.code)).map(r => r.name);
  res.send({ student, eligibleDepts });
});

app.get('/eligibility-rules', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  const rules = await db.collection('eligibility_rules').find().sort({ code: 1 }).toArray();
  res.send(rules);
});

app.patch('/eligibility-rules/:code', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  await db.collection('eligibility_rules').updateOne({ code: req.params.code }, { $set: req.body });
  res.send({ success: true });
});

app.post('/seed-rules', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  const rules = require('./department_rules.json');
  await db.collection('eligibility_rules').deleteMany({});
  await db.collection('eligibility_rules').insertMany(rules);
  res.send({ success: true });
});

app.get('/seed-admin', async (req, res) => {
  const db = await getDatabase();
  const hashedPassword = await bcrypt.hash('admin123', 10);
  await db.collection('admins').updateOne({ username: 'admin' }, { $set: { password: hashedPassword } }, { upsert: true });
  res.send({ message: 'Admin seeded' });
});

app.get('/departments', async (req, res) => {
  const db = await getDatabase();
  const depts = await db.collection('departments').find().toArray();
  res.send(depts);
});

app.get('/submissions', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  const subs = await db.collection('submissions').find().sort({ _id: -1 }).toArray();
  res.send(subs);
});

server.listen(port, () => console.log(`Robust Server running on port ${port}`));
