const { MongoClient } = require('mongodb');

// Standard connection string (using one of the shard addresses if possible, or trying a different DNS resolver)
// Since I cannot know the exact shard IP, I'll try a small logic change to use standard dns
const uri = "mongodb+srv://admission:admission123@cluster0.p1ca9.mongodb.net/admission?retryWrites=true&w=majority";

(async () => {
    // Adding family: 4 to force IPv4 which often helps with DNS issues in some environments
    const client = new MongoClient(uri, { family: 4 });
    try {
        await client.connect();
        const db = client.db('admission');
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
        console.log('--- Database Check for Specific Students ---');
        students.forEach(s => {
            console.log(`Name: ${s.name} | Gender in DB: ${s.gender}`);
        });
    } catch (e) { console.error(e); }
    finally { await client.close(); }
})();
