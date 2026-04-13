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

const allowedOrigins = [frontendUrl, 'http://localhost:5173', 'https://pustregistration.netlify.app'];

const io = new Server(server, {
  cors: { 
    origin: allowedOrigins, 
    methods: ['GET', 'POST'], 
    credentials: true 
  }
});

// CORS Configuration
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));

app.options(/.*/, cors());

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const SSLCommerzPayment = require('sslcommerz-lts');
const crypto = require('crypto');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });
const ALGORITHM = 'aes-256-cbc';
const MASTER_KEY = Buffer.from(process.env.MASTER_KEY || 'f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8');

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
  if (!cachedClient || !cachedClient.topology || !cachedClient.topology.isConnected()) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    });
    await client.connect();
    cachedClient = client;
  }
  return cachedClient.db('admission');
}

app.use(express.json());
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
  });
});

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

// GST Upload Route
app.post('/upload-gst', verifyAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send({ message: 'No file' });
    const jobId = new ObjectId().toString();
    console.log('Starting upload job:', jobId);
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    
    res.send({ jobId, total: data.length });

    setImmediate(async () => {
      try {
        const db = await getDatabase();
        const batchSize = 1000;
        const startTime = Date.now();

        for (let i = 0; i < data.length; i += batchSize) {
          const chunk = data.slice(i, i + batchSize);
          const ops = chunk.map(item => ({
            updateOne: { filter: { admission_roll: item.admission_roll }, update: { $set: item }, upsert: true }
          }));
          await db.collection('gst_results').bulkWrite(ops);
          
          const progress = Math.min(100, Math.round(((i + chunk.length) / data.length) * 100));
          const elapsedTime = (Date.now() - startTime) / 1000;
          const remainingTime = Math.round((elapsedTime / (i + chunk.length)) * (data.length - (i + chunk.length)));
          
          io.to(jobId).emit('progress', { progress, remainingTime, processed: i + chunk.length });
        }
        console.log('Upload job completed:', jobId);
        io.to(jobId).emit('completed');
      } catch (err) {
        console.error('Upload job error:', err);
        io.to(jobId).emit('error', { message: err.message });
      }
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// GST Export Route
app.get('/export-gst', verifyAdmin, async (req, res) => {
  try {
    const jobId = new ObjectId().toString();
    console.log('Starting export job:', jobId);
    res.send({ jobId });

    setImmediate(async () => {
      try {
        const db = await getDatabase();
        const students = await db.collection('gst_results').find().toArray();
        const rules = await db.collection('eligibility_rules').find().toArray();
        const startTime = Date.now();
        const exportData = [];

        console.log(`Exporting ${students.length} students...`);

        for (let i = 0; i < students.length; i++) {
          const student = students[i];
          const codes = checkEligibility(student, rules);
          exportData.push({
            'Roll': student.admission_roll,
            'Name': student.name,
            'GST Total': student.TOTAL,
            'Merit': student['Merit Position'],
            'Eligible_Codes': codes.join(',')
          });

          if (i % 2000 === 0 && i > 0) {
            const progress = Math.round((i / students.length) * 100);
            const elapsedTime = (Date.now() - startTime) / 1000;
            const remainingTime = Math.round((elapsedTime / i) * (students.length - i));
            io.to(jobId).emit('progress', { progress, remainingTime: remainingTime > 0 ? remainingTime : null, processed: i });
          }
        }

        console.log('Finalizing Excel buffer for job:', jobId);
        const ws = xlsx.utils.json_to_sheet(exportData);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Results');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        activeJobs.set(jobId, buffer);
        console.log(`Export job ${jobId} ready. Buffer size: ${buffer.length}`);
        io.to(jobId).emit('export-ready', { downloadUrl: `${serverUrl}/download-export/${jobId}` });
      } catch (err) {
        console.error('Export job error:', err);
        io.to(jobId).emit('error', { message: err.message });
      }
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.get('/download-export/:jobId', (req, res) => {
  console.log('Download requested for jobId:', req.params.jobId);
  const buffer = activeJobs.get(req.params.jobId);
  if (!buffer) {
    console.error('Buffer not found for jobId:', req.params.jobId);
    return res.status(404).send('File not found or expired');
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=gst_submission.xlsx`);
  res.send(buffer);
  
  // Clean up after 5 minutes to ensure slow downloads finish
  setTimeout(() => {
    activeJobs.delete(req.params.jobId);
    console.log('Cleaned up buffer for jobId:', req.params.jobId);
  }, 300000);
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
