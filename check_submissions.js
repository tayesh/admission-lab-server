const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

async function checkSubmissions() {
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverApi: { version: ServerApiVersion.v1 },
  });
  try {
    await client.connect();
    const db = client.db('admission');
    const subs = await db.collection('submissions').find({}).toArray();
    
    console.log('Total Submissions:', subs.length);
    subs.forEach((s, i) => {
      console.log(`[${i}] Roll: ${s.admission_roll}, Session: "${s.session}", Status: "${s.paymentStatus}"`);
    });
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

checkSubmissions();
