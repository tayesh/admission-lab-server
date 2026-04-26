const express = require('express');
const app = express();
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const server = http.createServer(app);

const port = process.env.PORT || 5000;
const serverUrl = (process.env.SERVER_URL || `http://localhost:${port}`).replace(/\/$/, '');
const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5174').replace(/\/$/, '');

const allowedOrigins = [
  frontendUrl, 
  'http://localhost:5174', 
  'https://pustregistration.netlify.app'
];

const io = new Server(server, {
  cors: { 
    origin: true,
    methods: ['GET', 'POST'], 
    credentials: true 
  }
});

// CORS Configuration
const corsOptions = {
  origin: true,
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
const puppeteer = require('puppeteer');

// Use OS temp directory for uploads to save RAM
const upload = multer({ dest: os.tmpdir() });
const ALGORITHM = 'aes-256-cbc';
const ADMISSION_FEE = 8900;

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
    
    // Ensure index for performance and to prevent sort memory limits
    const db = client.db('admission');
    await db.collection('gst_results').createIndex({ admission_roll: 1, session: 1, unit: 1 }, { unique: true });
    await db.collection('gst_results').createIndex({ "Merit Position": 1 });
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
const parseSscSubjectGpa = (sscLtrgrd, subjectCode) => {
  if (!sscLtrgrd || typeof sscLtrgrd !== 'string') return 0;
  const gradeMap = {
    'A+': 5.00, 'A': 4.00, 'A-': 3.50,
    'B': 3.00, 'C': 2.00, 'D': 1.00, 'F': 0.00
  };
  const entries = sscLtrgrd.split(',');
  for (const entry of entries) {
    const parts = entry.trim().split(':');
    if (parts.length < 2) continue;
    const code = parts[0].trim();
    const grade = parts[1].trim();
    if (code === String(subjectCode)) {
      return gradeMap[grade] ?? 0;
    }
  }
  return 0;
};

const checkEligibility = (student, rules) => {
  const eligibleDepts = [];

  const getMark = (field) => {
    const v = student[field];
    if (v === undefined || String(v).trim() === '--' || String(v).trim() === '') return 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };

  const getGpa = (field) => {
    const v = student[field];
    if (v === undefined || String(v).trim() === '--' || String(v).trim() === '') return 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };

  const total = getMark('TOTAL');
  const studentUnit = (student.unit || '').toUpperCase().trim();

  rules.forEach(dept => {
    let isEligible = true;

    // 1. Unit check
    if (dept.allowed_units && dept.allowed_units.length > 0) {
      if (!dept.allowed_units.includes(studentUnit)) {
        isEligible = false;
      }
    }

    // 2. Required subjects must have a positive mark
    if (isEligible && dept.required_subjects && dept.required_subjects.length > 0) {
      for (const sub of dept.required_subjects) {
        if (getMark(sub) <= 0) {
          isEligible = false;
          break;
        }
      }
    }

    // 3. Minimum subject percentage of total marks (e.g. MATH >= 20%, BIO >= 20%, ENG >= 20%)
    if (isEligible && dept.min_subject_pct && total > 0) {
      for (const [subject, minPct] of Object.entries(dept.min_subject_pct)) {
        const actualPct = (getMark(subject) / total) * 100;
        if (actualPct < minPct) {
          isEligible = false;
          break;
        }
      }
    }

    // 4. must_have_math_if_unit_A — only applies when student is A unit
    if (isEligible && dept.must_have_math_if_unit_A && studentUnit === 'A') {
      if (getMark('MATH') <= 0) {
        isEligible = false;
      }
    }

    // 5. PHARM special conditions
    if (isEligible && dept.pharm_special) {
      const p = dept.pharm_special;
      const hsc_gpa = getGpa('hsc_gpa');
      const ssc_gpa = getGpa('ssc_gpa');
      const total_gpa = hsc_gpa + ssc_gpa;

      if (hsc_gpa < p.min_hsc_gpa) isEligible = false;
      if (isEligible && ssc_gpa < p.min_ssc_gpa) isEligible = false;
      if (isEligible && total_gpa < p.min_total_gpa) isEligible = false;
      if (isEligible && getGpa('hsc_physics_gp') < p.min_hsc_phy_math_gpa) isEligible = false;
      if (isEligible && getGpa('hsc_mathe_gp') < p.min_hsc_phy_math_gpa) isEligible = false;
      if (isEligible && getGpa('hsc_chemistry_gp') < p.min_hsc_chem_bio_gpa) isEligible = false;
      if (isEligible && getGpa('hsc_biology_gp') < p.min_hsc_chem_bio_gpa) isEligible = false;

      const sscChemGpa = parseSscSubjectGpa(student.ssc_ltrgrd, 137);
      const sscBioGpa  = parseSscSubjectGpa(student.ssc_ltrgrd, 138);
      if (isEligible && sscChemGpa < p.min_ssc_chem_bio_gpa) isEligible = false;
      if (isEligible && sscBioGpa  < p.min_ssc_chem_bio_gpa) isEligible = false;
    }

    if (isEligible) {
      eligibleDepts.push(dept.code);
    }
  });

  return eligibleDepts;
};

// ===== Background Jobs =====
const activeJobs = new Map();

const normalizeStudent = (raw, unit) => {
  const u = (unit || '').toUpperCase().trim();

  const parseNum = (v) => {
    if (v === undefined || v === null) return 0;
    const s = String(v).trim();
    if (s === '' || s === '--') return 0;
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  };

  const parseStr = (v) => {
    if (v === undefined || v === null) return '';
    return String(v).trim();
  };

  // Roll number: B unit uses 'Adm_Roll', others use 'admission_roll'
  const admission_roll = raw.admission_roll || raw.Adm_Roll || raw.adm_roll || null;

  // Total marks: A unit uses 'TOTAL', B and C use 'Total'
  const TOTAL = parseNum(raw.TOTAL ?? raw.Total);

  return {
    // Identity
    admission_roll,
    name:            parseStr(raw.name),
    fname:           parseStr(raw.fname),
    mname:           parseStr(raw.mname),
    dob:             parseStr(raw.dob),
    gender:          parseStr(raw.gender),
    mobile:          parseStr(raw.mobile),

    // HSC common fields
    hsc_exam_name:   parseStr(raw.hsc_exam_name),
    hsc_board:       parseStr(raw.hsc_board),
    hsc_regi:        parseStr(raw.hsc_regi),
    hsc_session:     parseStr(raw.hsc_session),
    hsc_roll:        parseStr(raw.hsc_roll),
    hsc_pass_year:   parseStr(raw.hsc_pass_year),
    hsc_study_group: parseStr(raw.hsc_study_group),
    hsc_study_type:  parseStr(raw.hsc_study_type),
    hsc_gpa:         parseNum(raw.hsc_gpa),
    hsc_tot_obt:     parseStr(raw.hsc_tot_obt),
    hsc_full:        parseStr(raw.hsc_full),
    hsc_conv_1000:   parseStr(raw.hsc_conv_1000),
    hsc_ltrgd:       parseStr(raw.hsc_ltrgd),
    hsc_marks:       parseStr(raw.hsc_marks),

    // HSC Bangla & English (all units)
    hsc_bangla_lg:      parseStr(raw.hsc_bangla_lg),
    hsc_bangla_gp:      parseNum(raw.hsc_bangla_gp),
    hsc_bangla_marks:   parseStr(raw.hsc_bangla_marks),
    hsc_english_lg:     parseStr(raw.hsc_english_lg),
    hsc_english_gp:     parseNum(raw.hsc_english_gp),
    hsc_english_marks:  parseStr(raw.hsc_english_marks),

    // HSC subject GPAs — A unit
    hsc_physics_gp:     parseNum(raw.hsc_physics_gp),
    hsc_chemistry_gp:   parseNum(raw.hsc_chemistry_gp),
    hsc_mathe_gp:       parseNum(raw.hsc_mathe_gp),
    hsc_biology_gp:     parseNum(raw.hsc_biology_gp),

    // HSC subject GPAs — B unit
    hsc_history_gp:     parseNum(raw.hsc_history_gp),
    hsc_civics_gp:      parseNum(raw.hsc_civics_gp),
    hsc_economics_gp:   parseNum(raw.hsc_economics_gp),
    hsc_stat_gp:        parseNum(raw.hsc_stat_gp),

    // HSC subject GPAs — C unit
    hsc_accounting_gp:  parseNum(raw.hsc_accounting_gp),
    hsc_bom_gp:         parseNum(raw.hsc_bom_gp),

    // SSC common fields
    ssc_board:       parseStr(raw.ssc_board),
    ssc_regi:        parseStr(raw.ssc_regi),
    ssc_session:     parseStr(raw.ssc_session),
    ssc_roll:        parseStr(raw.ssc_roll),
    ssc_pass_year:   parseStr(raw.ssc_pass_year),
    ssc_study_group: parseStr(raw.ssc_study_group),
    ssc_study_type:  parseStr(raw.ssc_study_type),
    ssc_ltrgrd:      parseStr(raw.ssc_ltrgrd),
    ssc_gpa:         parseNum(raw.ssc_gpa),
    total_gpa:       parseNum(raw.total_gpa),

    // SSC subject GPAs (used for PHARM eligibility check)
    ssc_chemistry_gp: parseNum(raw.ssc_chemistry_gp),
    ssc_biology_gp:   parseNum(raw.ssc_biology_gp),

    // Normalized score fields — checkEligibility always reads these exact names
    PHY:  parseNum(raw.PHY),
    CHEM: parseNum(raw.CHEM),
    MATH: parseNum(raw.MATH),
    BIO:  parseNum(raw.BIO),
    BAN:  parseNum(raw.BAN),
    ENG:  parseNum(raw.ENG),
    GK:   parseNum(raw.GK),
    ACC:  parseNum(raw.ACC),
    BOM:  parseNum(raw.BOM),
    TOTAL,
    'Merit Position': parseNum(raw['Merit Position']),

    // Unit stored on the document — checkEligibility reads this for unit-based rules
    unit: u,
  };
};

// GST Upload Batch Route (Memory Safe)
app.post('/upload-gst-batch', verifyAdmin, async (req, res) => {
  try {
    const { items, jobId, isLast, session, unit } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).send({ message: 'No items provided' });
    if (!session || !unit) return res.status(400).send({ message: 'Session and Unit are required' });

    const db = await getDatabase();
    const ops = items.map(raw => {
      const item = normalizeStudent(raw, unit);
      return {
        updateOne: {
          filter: { admission_roll: item.admission_roll, session, unit },
          update: { $set: { ...item, session, unit } },
          upsert: true
        }
      };
    });

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
    const { session, unit } = req.query;
    if (!session || !unit) return res.status(400).send({ message: 'Session and Unit are required' });

    const jobId = new ObjectId().toString();
    const tempFilePath = path.join(os.tmpdir(), `export_${jobId}.csv`);
    res.send({ jobId });

    setImmediate(async () => {
      const writeStream = fs.createWriteStream(tempFilePath);
      try {
        const db = await getDatabase();
        const rules = await getRules(db);
        const query = { session, unit };
        const cursor = db.collection('gst_results').find(query).sort({ "Merit Position": 1 }).allowDiskUse(true);
        const total = await db.collection('gst_results').countDocuments(query);
        
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

// ===== Hall Assignment Logic =====

const assignHall = (gender, hallConfig) => {
  const g = (gender || '').toLowerCase().trim();
  if (g === 'male' || g === 'm') {
    const total = hallConfig.male_ratio_1 + hallConfig.male_ratio_2;
    const rand = Math.random() * total;
    return rand < hallConfig.male_ratio_1
      ? hallConfig.male_hall_1
      : hallConfig.male_hall_2;
  } else if (g === 'female' || g === 'f') {
    const total = hallConfig.female_ratio_1 + hallConfig.female_ratio_2;
    const rand = Math.random() * total;
    return rand < hallConfig.female_ratio_1
      ? hallConfig.female_hall_1
      : hallConfig.female_hall_2;
  }
  return 'Unassigned';
};

app.get('/hall-config', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  let config = await db.collection('hall_config').findOne({});
  if (!config) {
    config = {
      male_hall_1: 'Shadhinata Hall',
      male_hall_2: 'July 6 Hall',
      male_ratio_1: 1,
      male_ratio_2: 3,
      female_hall_1: 'Matribhasha Hall',
      female_hall_2: 'Ganatantra Hall',
      female_ratio_1: 1,
      female_ratio_2: 4
    };
  }
  res.send(config);
});

app.patch('/hall-config', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  await db.collection('hall_config').updateOne(
    {},
    { $set: req.body },
    { upsert: true }
  );
  res.send({ success: true });
});

app.post('/upload-final-list', verifyAdmin, async (req, res) => {
  try {
    const { items, jobId, isLast, session } = req.body;
    if (!items || !Array.isArray(items)) {
      return res.status(400).send({ message: 'No items provided' });
    }
    if (!session) {
      return res.status(400).send({ message: 'Session is required' });
    }

    const db = await getDatabase();

    let hallConfig = await db.collection('hall_config').findOne({});
    if (!hallConfig) {
      hallConfig = {
        male_hall_1: 'Shadhinata Hall',
        male_hall_2: 'July 6 Hall',
        male_ratio_1: 1,
        male_ratio_2: 3,
        female_hall_1: 'Matribhasha Hall',
        female_hall_2: 'Ganatantra Hall',
        female_ratio_1: 1,
        female_ratio_2: 4
      };
    }

    // Fetch genders for all admission rolls in the batch
    const rolls = items.map(row => {
      const r = row.Admission_roll || row.admission_roll || row.Adm_Roll || null;
      return r ? (typeof r === 'number' ? r : parseInt(r)) : null;
    }).filter(r => r !== null && !isNaN(r));

    const students = await db.collection('gst_results').find({
      admission_roll: { $in: rolls },
      session
    }, { projection: { admission_roll: 1, gender: 1 } }).toArray();

    const genderMap = {};
    students.forEach(s => {
      genderMap[String(s.admission_roll)] = s.gender || '';
    });

    const ops = await Promise.all(items.map(async row => {
      const admission_roll_raw = row.Admission_roll || row.admission_roll || row.Adm_Roll || null;
      const admission_roll = admission_roll_raw ? (typeof admission_roll_raw === 'number' ? admission_roll_raw : parseInt(admission_roll_raw)) : null;
      
      const gender = genderMap[String(admission_roll)] || '';
      const hall_name = assignHall(gender, hallConfig);

      const rawPassword = String(row.applicant_password || '').trim();
      const hashedPassword = await bcrypt.hash(rawPassword, 10);

      return {
        updateOne: {
          filter: { admission_roll, session },
          update: {
            $set: {
              applicant_id:       String(row.applicant_id || '').trim(),
              applicant_password: hashedPassword,
              dept_code:          String(row['Dept.Code'] || '').trim(),
              dept_name:          String(row.Current_Department || '').trim(),
              hall_name,
            }
          }
        }
      };
    }));

    if (ops.length > 0) {
      await db.collection('gst_results').bulkWrite(ops);
    }

    if (isLast) {
      io.to(jobId).emit('completed');
    }

    res.send({ success: true });
  } catch (error) {
    console.error('Final list upload error:', error);
    res.status(500).send({ error: error.message });
  }
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

app.post('/verify-admission-student', async (req, res) => {
  try {
    const { admissionRoll, hscRoll, hscRegi } = req.body;
    if (!admissionRoll || !hscRoll || !hscRegi) {
      return res.status(400).send({ message: 'All verification fields are required' });
    }

    const db = await getDatabase();
    const student = await db.collection('gst_results').findOne({ 
      admission_roll: parseInt(admissionRoll)
    });

    if (!student) {
      return res.status(404).send({ message: 'No student found with this Admission Roll' });
    }

    const isHscRollMatch = String(student.hsc_roll) === String(hscRoll);
    const isHscRegiMatch = String(student.hsc_regi) === String(hscRegi);

    if (!isHscRollMatch || !isHscRegiMatch) {
      return res.status(401).send({ message: 'HSC Roll or Registration Number does not match our records' });
    }

    const rules = await db.collection('eligibility_rules').find().toArray();
    const codes = checkEligibility(student, rules);
    const eligibleDepts = rules.filter(r => codes.includes(r.code)).map(r => ({
      code: r.code,
      name: r.name
    }));

    res.send({ 
      success: true, 
      student, 
      eligibleDepts 
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).send({ error: 'Internal server error during verification' });
  }
});

app.post('/test/generate-balanced-data', verifyAdmin, async (req, res) => {
  try {
    const db = await getDatabase();
    const rules = await db.collection('eligibility_rules').find().toArray();

    // Step 1: Clear ALL previous assignments across all units
    await db.collection('test_assignments').deleteMany({});

    // Step 2: Process each unit independently
    const units = ['A', 'B', 'C'];
    const allAssignments = [];
    const summary = {};

    for (const unit of units) {

      // Fetch students for this unit sorted by Merit Position ascending
      // Merit Position may be stored as string or number — sort numerically
      const students = await db.collection('gst_results')
        .find({ unit })
        .toArray();

      // Sort by Merit Position numerically ascending (rank 1 = highest priority)
      students.sort((a, b) => {
        const ma = parseInt(a['Merit Position']) || 999999;
        const mb = parseInt(b['Merit Position']) || 999999;
        return ma - mb;
      });

      // Step 3: Build seat tracker for this unit
      // seats_A / seats_B / seats_C tell us quota per unit per dept
      const seatKey = `seats_${unit}`;
      const seatTracker = {};
      rules.forEach(dept => {
        const quota = dept[seatKey] || 0;
        if (quota > 0) {
          seatTracker[dept.code] = { filled: 0, quota };
        }
      });

      // Step 4: Assign students to departments by merit order
      // Each student is assigned to the HIGHEST priority eligible dept
      // that still has seats — priority = lowest dept code number (001 first)
      const assignedRolls = new Set();

      for (const student of students) {
        if (assignedRolls.has(student.admission_roll)) continue;

        // Get all eligible dept codes for this student
        const eligibleCodes = checkEligibility(student, rules);

        // Filter to only depts that have seats available for this unit
        // and sort by dept code ascending (001 before 002 etc.) for priority
        const assignableDepts = eligibleCodes
          .filter(code => seatTracker[code] && seatTracker[code].filled < seatTracker[code].quota)
          .sort((a, b) => a.localeCompare(b));

        if (assignableDepts.length === 0) continue;

        // Assign to highest priority available dept
        const assignedCode = assignableDepts[0];
        const assignedDept = rules.find(r => r.code === assignedCode);

        seatTracker[assignedCode].filled++;
        assignedRolls.add(student.admission_roll);

        allAssignments.push({
          ...student,
          assigned_dept_code: assignedCode,
          assigned_dept_name: assignedDept ? assignedDept.name : assignedCode,
          assigned_unit: unit,
        });
      }

      // Track summary per unit
      summary[unit] = {
        total_students: students.length,
        assigned: assignedRolls.size,
        seat_fill: Object.entries(seatTracker).map(([code, s]) => ({
          code,
          filled: s.filled,
          quota: s.quota
        }))
      };
    }

    // Step 5: Insert all assignments
    if (allAssignments.length > 0) {
      await db.collection('test_assignments').insertMany(allAssignments);
    }

    res.send({
      success: true,
      total_assigned: allAssignments.length,
      summary
    });

  } catch (error) {
    console.error(error);
    res.status(500).send({ error: 'Failed to generate assignments' });
  }
});

app.get('/test/check-gender-debug', async (req, res) => {
  try {
    const db = await getDatabase();
    const names = [
      'RAFID AL SAHAF', 
      'MD.SAIFUL ISLAM', 
      'MD.AFIF HASAN', 
      'MD. MAHAFUJ UL ALAM',
      'MD. NURUZZAMAN TOSHA',
      'TAJRIN TAMANNA',
      'MD. MOMTAIN JAMAN TASIN'
    ];
    const students = await db.collection('gst_results').find({ name: { $in: names } }).toArray();
    const result = students.map(s => ({ name: s.name, gender: s.gender }));
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.get('/gst-results', verifyAdmin, async (req, res) => {
  const { search, page = 1, limit = 21, session, unit } = req.query;
  const db = await getDatabase();
  
  let query = {};
  if (session) query.session = session;
  if (unit) query.unit = unit;
  if (search) query.admission_roll = parseInt(search);

  const results = await db.collection('gst_results')
    .find(query)
    .sort({'Merit Position':1})
    .skip((page-1)*limit)
    .limit(parseInt(limit))
    .toArray();
    
  const total = await db.collection('gst_results').countDocuments(query);
  res.send({ results, total, page, totalPages: Math.ceil(total/limit) });
});

app.delete('/gst-results', verifyAdmin, async (req, res) => {
  try {
    const { session, unit } = req.query;
    const db = await getDatabase();
    
    let query = {};
    if (session) query.session = session;
    if (unit) query.unit = unit;

    console.log(`Initiating deletion of GST results for Session: ${session || 'All'}, Unit: ${unit || 'All'}...`);
    const result = await db.collection('gst_results').deleteMany(query);
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
  cachedRules = null;
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

app.post('/departments', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  const { sslStorePass, ...data } = req.body;
  const encrypted = sslStorePass ? encrypt(sslStorePass) : null;
  const newDept = { 
    ...data, 
    sslStorePassEncrypted: encrypted?.encryptedData, 
    sslIv: encrypted?.iv 
  };
  await db.collection('departments').insertOne(newDept);
  res.status(201).send({ success: true });
});

app.patch('/departments/:id', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  const { sslStorePass, ...data } = req.body;
  const updateData = { ...data };
  if (sslStorePass) {
    const encrypted = encrypt(sslStorePass);
    updateData.sslStorePassEncrypted = encrypted.encryptedData;
    updateData.sslIv = encrypted.iv;
  }
  await db.collection('departments').updateOne({ _id: new ObjectId(req.params.id) }, { $set: updateData });
  res.send({ success: true });
});

app.delete('/departments/:id', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  await db.collection('departments').deleteOne({ _id: new ObjectId(req.params.id) });
  res.send({ success: true });
});

app.post('/initiate-payment', async (req, res) => {
  const { submissionData } = req.body;
  const db = await getDatabase();
  
  // Get department credentials for SSLCommerz
  const dept = await db.collection('departments').findOne({ name: submissionData.department });
  if (!dept || !dept.sslStoreId || !dept.sslStorePassEncrypted) {
    return res.status(400).send({ message: 'Department payment not configured' });
  }

  const storeId = dept.sslStoreId;
  const storePass = decrypt(dept.sslStorePassEncrypted, dept.sslIv);
  const isLive = false; // Set to true for production

  const transId = new ObjectId().toString();
  const sslcz = new SSLCommerzPayment(storeId, storePass, isLive);
  
  const paymentData = {
    total_amount: submissionData.feeAmount,
    currency: 'BDT',
    tran_id: transId,
    success_url: `${serverUrl}/payment-success/${transId}`,
    fail_url: `${serverUrl}/payment-fail/${transId}`,
    cancel_url: `${serverUrl}/payment-cancel/${transId}`,
    ipn_url: `${serverUrl}/ipn`,
    shipping_method: 'NO',
    product_name: `Admission Fee - ${submissionData.department}`,
    product_category: 'Education',
    product_profile: 'general',
    cus_name: submissionData.name,
    cus_email: 'customer@example.com',
    cus_add1: 'Dhaka',
    cus_city: 'Dhaka',
    cus_postcode: '1000',
    cus_country: 'Bangladesh',
    cus_phone: '01700000000',
  };

  sslcz.init(paymentData).then(async (apiResponse) => {
    let GatewayPageURL = apiResponse.GatewayPageURL;
    if (GatewayPageURL) {
      // Save pending submission
      await db.collection('submissions').insertOne({
        ...submissionData,
        tranId: transId,
        paymentStatus: 'Pending',
        submittedAt: new Date()
      });
      res.send({ url: GatewayPageURL });
    } else {
      res.status(400).send({ message: 'SSLCommerz init failed' });
    }
  });
});

app.post('/payment-success/:tranId', async (req, res) => {
  const db = await getDatabase();
  await db.collection('submissions').updateOne(
    { tranId: req.params.tranId },
    { $set: { paymentStatus: 'Paid', paymentDetails: req.body } }
  );
  res.redirect(`${frontendUrl}/payment-success`);
});

app.post('/payment-fail/:tranId', async (req, res) => {
  const db = await getDatabase();
  await db.collection('submissions').updateOne(
    { tranId: req.params.tranId },
    { $set: { paymentStatus: 'Failed', paymentDetails: req.body } }
  );
  res.redirect(`${frontendUrl}/payment-fail`);
});

app.post('/payment-cancel/:tranId', async (req, res) => {
  const db = await getDatabase();
  await db.collection('submissions').updateOne(
    { tranId: req.params.tranId },
    { $set: { paymentStatus: 'Cancelled' } }
  );
  res.redirect(`${frontendUrl}/payment-cancel`);
});

app.get('/submissions', verifyAdmin, async (req, res) => {
  const db = await getDatabase();
  const subs = await db.collection('submissions').find().sort({ _id: -1 }).toArray();
  res.send(subs);
});

// ===== Student Registration Routes =====

app.post('/student-login', async (req, res) => {
  try {
    const { applicant_id, applicant_password, session, unit } = req.body;
    if (!applicant_id || !applicant_password || !session || !unit) {
      return res.status(400).send({ message: 'All fields required' });
    }

    const db = await getDatabase();
    const student = await db.collection('gst_results').findOne({
      applicant_id: applicant_id.trim(),
      session,
      unit
    });

    if (!student) {
      return res.status(404).send({ message: 'Student not found' });
    }

    const isMatch = await bcrypt.compare(
      applicant_password.trim(),
      student.applicant_password
    );
    if (!isMatch) {
      return res.status(401).send({ message: 'Invalid credentials' });
    }

    // Check if already registered
    const existing = await db.collection('submissions').findOne({
      admission_roll: student.admission_roll,
      session,
      unit
    });
    if (existing && existing.paymentStatus === 'Paid') {
      return res.status(409).send({
        message: 'Already registered',
        alreadyRegistered: true
      });
    }

    // Return pre-filled data — never send applicant_password
    const { applicant_password: _pw, ...safeStudent } = student;
    res.send({ success: true, student: safeStudent });

  } catch (error) {
    console.error('Student login error:', error);
    res.status(500).send({ error: 'Internal server error' });
  }
});

app.post('/initiate-student-payment', async (req, res) => {
  try {
    const { formData, session, unit } = req.body;
    if (!formData || !session || !unit) {
      return res.status(400).send({ message: 'Missing required fields' });
    }

    const db = await getDatabase();

    // Verify student exists and is not already registered
    const student = await db.collection('gst_results').findOne({
      applicant_id: formData.applicant_id,
      session,
      unit
    });
    if (!student) {
      return res.status(404).send({ message: 'Student not found' });
    }

    const existing = await db.collection('submissions').findOne({
      admission_roll: student.admission_roll,
      session,
      unit,
      paymentStatus: 'Paid'
    });
    if (existing) {
      return res.status(409).send({ message: 'Already registered' });
    }

    // Fetch faculty for the department
    const deptRule = await db.collection('eligibility_rules').findOne({ code: student.dept_code });
    const faculty = deptRule ? deptRule.faculty : '';

    const storeId = process.env.SSL_STORE_ID;
    const storePass = process.env.SSL_STORE_PASSWORD;
    if (!storeId || !storePass) {
      return res.status(500).send({ message: 'Payment not configured' });
    }

    const transId = new ObjectId().toString();
    const isLive = false;
    const sslcz = new SSLCommerzPayment(storeId, storePass, isLive);

    const paymentData = {
      total_amount:     ADMISSION_FEE,
      currency:         'BDT',
      tran_id:          transId,
      success_url:      `${serverUrl}/student-payment-success/${transId}`,
      fail_url:         `${serverUrl}/student-payment-fail/${transId}`,
      cancel_url:       `${serverUrl}/student-payment-cancel/${transId}`,
      ipn_url:          `${serverUrl}/ipn`,
      shipping_method:  'NO',
      product_name:     'PUST Admission Fee',
      product_category: 'Education',
      product_profile:  'general',
      cus_name:         formData.name        || '',
      cus_email:        'student@pust.ac.bd',
      cus_add1:         formData.permanent_address || 'Bangladesh',
      cus_city:         formData.home_district     || 'Pabna',
      cus_postcode:     '6600',
      cus_country:      'Bangladesh',
      cus_phone:        formData.mobile      || '01700000000',
    };

    const apiResponse = await sslcz.init(paymentData);
    const GatewayPageURL = apiResponse.GatewayPageURL;

    if (!GatewayPageURL) {
      return res.status(400).send({ message: 'Payment gateway error' });
    }

    // Clear any previous incomplete attempts for this student
    await db.collection('temp_submissions').deleteMany({ 
      admission_roll: student.admission_roll,
      session,
      unit
    });

    // Save data to temporary collection during payment initiation
    await db.collection('temp_submissions').insertOne({
      ...formData,
      admission_roll:  student.admission_roll,
      dept_code:       student.dept_code,
      dept_name:       student.dept_name,
      hall_name:       student.hall_name,
      faculty,
      session,
      unit,
      tranId:          transId,
      paymentStatus:   'Pending',
      feeAmount:       ADMISSION_FEE,
      createdAt:       new Date() 
    });

    res.send({ url: GatewayPageURL, tranId: transId });

  } catch (error) {
    console.error('Payment initiation error:', error);
    res.status(500).send({ error: error.message });
  }
});

app.post('/student-payment-success/:tranId', async (req, res) => {
  try {
    const db = await getDatabase();
    
    // 1. Find the data from temporary storage
    const pendingData = await db.collection('temp_submissions').findOne({ tranId: req.params.tranId });
    
    if (pendingData) {
      const { _id, ...cleanData } = pendingData;
      
      // 2. Move to the permanent submissions collection
      await db.collection('submissions').insertOne({
        ...cleanData,
        paymentStatus:     'Paid',
        paymentDetails:    req.body,
        paidAt:            new Date(),
        bankReceiptNo:     req.body.bank_tran_id || '',
        paymentDate:       req.body.tran_date    || new Date().toISOString()
      });

      // 3. Clean up the temporary record
      await db.collection('temp_submissions').deleteOne({ tranId: req.params.tranId });
    }
    
    res.redirect(`${frontendUrl}/registration-success?tran=${req.params.tranId}`);
  } catch (error) {
    console.error('Payment success processing error:', error);
    res.status(500).send("An error occurred while finalizing your registration.");
  }
});

app.post('/student-payment-fail/:tranId', async (req, res) => {
  const db = await getDatabase();
  // Clean up temporary data on failure
  await db.collection('temp_submissions').deleteOne({ tranId: req.params.tranId });
  res.redirect(`${frontendUrl}/registration-failed`);
});

app.post('/student-payment-cancel/:tranId', async (req, res) => {
  const db = await getDatabase();
  // Clean up temporary data on cancellation
  await db.collection('temp_submissions').deleteOne({ tranId: req.params.tranId });
  res.redirect(`${frontendUrl}/registration-cancelled`);
});

app.get('/submission/:tranId', async (req, res) => {
  try {
    const db = await getDatabase();
    const submission = await db.collection('submissions').findOne({
      tranId: req.params.tranId,
      paymentStatus: 'Paid'
    });
    if (!submission) {
      return res.status(404).send({ message: 'Submission not found' });
    }
    res.send(submission);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// ===== Hall Management Integration =====

const formatStudentForHall = (submission) => {
  const sessionStr = String(submission.session || '');
  const admissionYear = sessionStr.includes('-')
    ? parseInt(sessionStr.split('-')[0]) || null
    : null;

  return {
    // maps to users table
    user: {
      name:             submission.name             || '',
      phone:            submission.mobile           || '',
      role:             'student',
      approval_status:  'approved',
    },

    // maps to student_details table
    student_details: {
      roll:              String(submission.admission_roll || ''),
      registration:      submission.reg_no           || '',
      academic_session:  submission.session          || '',
      admission_year:    admissionYear,
      department:        submission.dept_name        || '',
      blood_group:       submission.blood_group      || '',
      father_name:       submission.fname            || '',
      mother_name:       submission.mname            || '',
      father_phone:      submission.father_phone     || '',
      emergency_contact: submission.guardian_mobile  || '',
      permanent_address: submission.permanent_address|| '',
      medical_info:      submission.medical_info     || '',
      hall_name:         submission.hall_name        || '',
    },

    // extra identifiers for reference
    meta: {
      admission_roll:   submission.admission_roll   || '',
      dept_code:        submission.dept_code        || '',
      unit:             submission.unit             || '',
      gender:           submission.gender           || '',
      merit_position:   submission['Merit Position']|| '',
      bank_receipt_no:  submission.bankReceiptNo    || '',
      paid_at:          submission.paidAt           || null,
      session:          submission.session          || '',
    }
  };
};

app.get('/hall-data', async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) {
      return res.status(400).send({ message: 'session query param required' });
    }

    const db = await getDatabase();
    const query = { paymentStatus: 'Paid', session };

    const submissions = await db.collection('submissions')
      .find(query)
      .sort({ admission_roll: 1 })
      .toArray();

    if (submissions.length === 0) {
      return res.status(404).send({
        message: 'No registered students found for this session'
      });
    }

    const students = submissions.map(formatStudentForHall);

    res.send({
      success:  true,
      session,
      total:    students.length,
      students
    });

  } catch (error) {
    console.error('Hall data fetch error:', error);
    res.status(500).send({ error: error.message });
  }
});

app.get('/hall-data/:admission_roll', async (req, res) => {
  try {
    const { session } = req.query;
    const admission_roll = req.params.admission_roll;

    if (!admission_roll) {
      return res.status(400).send({ message: 'admission_roll is required' });
    }

    const db = await getDatabase();

    const rollValue = isNaN(admission_roll) ? admission_roll : parseInt(admission_roll);
    const query = {
      paymentStatus: 'Paid',
      admission_roll: { $in: [rollValue, String(rollValue)] }
    };

    if (session) query.session = session;

    const submission = await db.collection('submissions').findOne(query);

    if (!submission) {
      return res.status(404).send({
        message: `No registered student found with admission roll: ${admission_roll}`
      });
    }

    res.send({
      success: true,
      student: formatStudentForHall(submission)
    });

  } catch (error) {
    console.error('Hall data single fetch error:', error);
    res.status(500).send({ error: error.message });
  }
});

app.get('/generate-pdf/:tranId', async (req, res) => {
  try {
    const db = await getDatabase();
    const submission = await db.collection('submissions').findOne({
      tranId: req.params.tranId,
      paymentStatus: 'Paid'
    });

    if (!submission) {
      return res.status(404).send({ message: 'Paid submission not found' });
    }

    // Load HTML template from project root (one level up from Lab server)
    const templatePath = path.join(__dirname, '..', 'registration_form_template.html');
    let html = fs.readFileSync(templatePath, 'utf8');

    // Format payment date
    const paymentDate = submission.paidAt
      ? new Date(submission.paidAt).toLocaleString('en-BD', { timeZone: 'Asia/Dhaka' })
      : '';

    // Replace all placeholders
    const replacements = {
      '{{SESSION}}':           submission.session             || '',
      '{{PHOTO_URL}}':         submission.photo_url           || '',
      '{{SUBJECT}}':           submission.dept_name           || '',
      '{{FACULTY}}':           submission.faculty             || '',
      '{{HALL}}':              submission.hall_name           || '',
      '{{ADMISSION_ROLL}}':    submission.admission_roll      || '',
      '{{GST_UNIT}}':          submission.unit                || '',
      '{{MERIT_POSITION}}':    submission['Merit Position']   || '',
      '{{SCORE}}':             submission.TOTAL               || '',
      '{{AMOUNT_PAID}}':       submission.feeAmount           || '',
      '{{REG_NO}}':            submission.reg_no              || '',
      '{{BANK_RECEIPT_NO}}':   submission.bankReceiptNo       || '',
      '{{CLASS_ROLL}}':        submission.class_roll          || '',
      '{{PAYMENT_DATE}}':      paymentDate,
      '{{NAME_EN}}':           submission.name                || '',
      '{{NAME_BN}}':           submission.name_bn             || '',
      '{{FATHER_NAME}}':       submission.fname               || '',
      '{{MOTHER_NAME}}':       submission.mname               || '',
      '{{FATHER_OCC}}':        submission.father_occupation   || '',
      '{{MOTHER_OCC}}':        submission.mother_occupation   || '',
      '{{FAMILY_INCOME}}':     submission.family_income       || '',
      '{{BNCC_ROVER}}':        submission.bncc_rover          || '',
      '{{NATIONALITY}}':       submission.nationality         || '',
      '{{HOME_DISTRICT}}':     submission.home_district       || '',
      '{{MARITAL_STATUS}}':    submission.marital_status      || '',
      '{{GENDER}}':            submission.gender              || '',
      '{{DOB}}':               submission.dob                 || '',
      '{{MOBILE}}':            submission.mobile              || '',
      '{{BLOOD_GROUP}}':       submission.blood_group         || '',
      '{{FATHER_PHONE}}':      submission.father_phone        || '',
      '{{PERMANENT_ADDRESS}}': submission.permanent_address   || '',
      '{{PRESENT_ADDRESS}}':   submission.present_address     || '',
      '{{GUARDIAN_NAME}}':     submission.guardian_name       || '',
      '{{GUARDIAN_MOBILE}}':   submission.guardian_mobile     || '',
      '{{GUARDIAN_RELATION}}': submission.guardian_relation   || '',
      '{{RELIGION}}':          submission.religion            || '',
      '{{GUARDIAN_ADDRESS}}':  submission.guardian_address    || '',
      '{{MEDICAL_INFO}}':      submission.medical_info        || '',
      '{{SSC_GROUP}}':         submission.ssc_study_group     || '',
      '{{SSC_ROLL}}':          submission.ssc_roll            || '',
      '{{SSC_REGI}}':          submission.ssc_regi            || '',
      '{{SSC_GPA}}':           submission.ssc_gpa             || '',
      '{{SSC_BOARD}}':         submission.ssc_board           || '',
      '{{SSC_YEAR}}':          submission.ssc_pass_year       || '',
      '{{HSC_GROUP}}':         submission.hsc_study_group     || '',
      '{{HSC_ROLL}}':          submission.hsc_roll            || '',
      '{{HSC_REGI}}':          submission.hsc_regi            || '',
      '{{HSC_GPA}}':           submission.hsc_gpa             || '',
      '{{HSC_BOARD}}':         submission.hsc_board           || '',
      '{{HSC_YEAR}}':          submission.hsc_pass_year       || '',
    };

    Object.entries(replacements).forEach(([placeholder, value]) => {
      html = html.replaceAll(placeholder, String(value));
    });

    // Generate PDF with puppeteer
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' }
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=PUST_Admission_Form_${submission.admission_roll}.pdf`
    );
    res.send(pdfBuffer);

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).send({ error: 'PDF generation failed' });
  }
});

server.listen(port, () => console.log(`Robust Server running on port ${port}`));
