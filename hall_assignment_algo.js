const { MongoClient, ServerApiVersion } = require('mongodb');
const xlsx = require('xlsx');
const path = require('path');
require('dotenv').config();

/**
 * Distributes students into halls based on provided ratios.
 * @param {number[]} maleRatios - Array of ratios for male halls (e.g., [1, 3])
 * @param {number[]} femaleRatios - Array of ratios for female halls (e.g., [1, 4])
 */
async function distributeHalls(maleRatios, femaleRatios) {
    const client = new MongoClient(process.env.MONGODB_URI, {
        serverApi: { version: ServerApiVersion.v1 },
    });

    try {
        await client.connect();
        const db = client.db('admission');

        // 1. Fetch all assigned students from the test collection
        const students = await db.collection('test_assignments').find().toArray();
        console.log(`Fetched ${students.length} students for hall assignment.`);

        if (students.length === 0) {
            console.log("No students found in 'test_assignments'. Run the /test/generate-balanced-data endpoint first.");
            return;
        }

        // 2. Define Hall Names based on ratio lengths
        const maleHalls = maleRatios.map((_, i) => `Male Hall ${i + 1}`);
        const femaleHalls = femaleRatios.map((_, i) => `Female Hall ${i + 1}`);

        // 3. Group students by gender and then by department for balanced distribution
        const groupStudents = (gender) => {
            const filtered = students.filter(s => (s.gender || '').toLowerCase() === gender.toLowerCase());
            // Group by department code
            const byDept = {};
            filtered.forEach(s => {
                const code = s.assigned_dept_code;
                if (!byDept[code]) byDept[code] = [];
                byDept[code].push(s);
            });

            // Shuffle each department group for randomness
            Object.keys(byDept).forEach(code => {
                const deptList = byDept[code];
                for (let i = deptList.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [deptList[i], deptList[j]] = [deptList[j], deptList[i]];
                }
            });

            return byDept;
        };

        const maleDeptGroups = groupStudents('male');
        const femaleDeptGroups = groupStudents('female');

        /**
         * Assignment Logic: Weighted Round-Robin across halls based on ratios
         */
        const assign = (deptGroups, halls, ratios) => {
            if (halls.length === 0) return [];
            const assigned = [];
            
            // Create a pool of hall indices based on ratios
            // If ratios is [1, 3], hallPool is [0, 1, 1, 1]
            const hallPool = [];
            ratios.forEach((ratio, hallIndex) => {
                for (let i = 0; i < ratio; i++) {
                    hallPool.push(hallIndex);
                }
            });

            let poolIndex = 0;
            const deptCodes = Object.keys(deptGroups);
            const maxInDept = Math.max(...Object.values(deptGroups).map(g => g.length), 0);

            // Interleave departments and students to ensure balance
            for (let i = 0; i < maxInDept; i++) {
                for (const code of deptCodes) {
                    const deptStudents = deptGroups[code];
                    if (deptStudents[i]) {
                        const hallIndex = hallPool[poolIndex];
                        assigned.push({
                            'Admission Roll': deptStudents[i].admission_roll,
                            'Student Name': deptStudents[i].name,
                            'Gender': deptStudents[i].gender,
                            'Dept Code': deptStudents[i].assigned_dept_code,
                            'Dept Name': deptStudents[i].assigned_dept_name,
                            'Assigned Hall': halls[hallIndex]
                        });
                        // Move to next index in the weighted pool
                        poolIndex = (poolIndex + 1) % hallPool.length;
                    }
                }
            }
            return assigned;
        };

        console.log(`Distributing male students with ratios [${maleRatios.join(':')}]...`);
        const maleAssignments = assign(maleDeptGroups, maleHalls, maleRatios);
        
        console.log(`Distributing female students with ratios [${femaleRatios.join(':')}]...`);
        const femaleAssignments = assign(femaleDeptGroups, femaleHalls, femaleRatios);

        let totalAssignments = [...maleAssignments, ...femaleAssignments];

        // Shuffle the total assignments list so the Excel report is interleaved
        for (let i = totalAssignments.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [totalAssignments[i], totalAssignments[j]] = [totalAssignments[j], totalAssignments[i]];
        }

        // 4. Export to Excel
        const wb = xlsx.utils.book_new();
        
        // Sheet 1: All Assignments
        const wsAll = xlsx.utils.json_to_sheet(totalAssignments);
        xlsx.utils.book_append_sheet(wb, wsAll, "All Assignments");

        // Sheets for each Hall
        const halls = [...maleHalls, ...femaleHalls];
        halls.forEach(hall => {
            const hallData = totalAssignments.filter(a => a['Assigned Hall'] === hall);
            if (hallData.length > 0) {
                const wsHall = xlsx.utils.json_to_sheet(hallData);
                xlsx.utils.book_append_sheet(wb, wsHall, hall.substring(0, 31)); // Excel sheet name limit 31 chars
            }
        });

        const fileName = `Hall_Assignments_${Date.now()}.xlsx`;
        const filePath = path.join(__dirname, fileName);
        xlsx.writeFile(wb, filePath);

        console.log(`\n✅ Successfully distributed ${totalAssignments.length} students.`);
        console.log(`📂 Excel file generated: ${filePath}`);
        
        // 5. Summary Report
        console.log("\n--- Quick Summary ---");
        halls.forEach(hall => {
            const count = totalAssignments.filter(a => a['Assigned Hall'] === hall).length;
            console.log(`${hall}: ${count} students`);
        });

    } catch (error) {
        console.error("Error during distribution:", error);
    } finally {
        await client.close();
    }
}

// Parse command line arguments: "1:3" "1:4"
// Usage: node hall_assignment_algo.js "1:3" "1:4"
const parseRatio = (arg, defaultVal) => {
    if (!arg) return defaultVal;
    // Handle both "1:3" and "3" (which becomes [1, 1, 1])
    if (arg.includes(':')) {
        return arg.split(':').map(n => parseInt(n) || 1);
    } else {
        const count = parseInt(arg) || defaultVal.length;
        return Array(count).fill(1);
    }
};

const mRatios = parseRatio(process.argv[2], [1, 1, 1]); // Default 3 halls if none
const fRatios = parseRatio(process.argv[3], [1, 1]);    // Default 2 halls if none

distributeHalls(mRatios, fRatios);
