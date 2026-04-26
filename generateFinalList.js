const fs = require('fs');
const path = require('path');

// Try to require xlsx from the Lab server directory if not found in root
let XLSX;
try {
    XLSX = require('xlsx');
} catch (e) {
    try {
        const serverXlsxPath = path.join(__dirname, 'Lab server', 'node_modules', 'xlsx');
        XLSX = require(serverXlsxPath);
    } catch (err) {
        console.error("Error: 'xlsx' package not found. Please run this script from an environment where 'xlsx' is available.");
        process.exit(1);
    }
}

/**
 * Generates a unique 10-character alphanumeric password
 */
function generatePassword(length = 10) {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let retVal = "";
    for (let i = 0; i < length; ++i) {
        retVal += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return retVal;
}

async function main() {
    try {
        const args = process.argv.slice(2);
        if (args.length === 0) {
            console.error("Error: No input file path provided.");
            console.log("Usage: node generateFinalList.js <path/to/idcard.xlsx>");
            process.exit(1);
        }

        const inputPath = args[0];
        if (!fs.existsSync(inputPath)) {
            console.error(`Error: File not found at path: ${inputPath}`);
            process.exit(1);
        }

        console.log(`Reading file: ${inputPath}...`);
        const workbook = XLSX.readFile(inputPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // Convert to JSON
        const data = XLSX.utils.sheet_to_json(worksheet);
        console.log(`Total rows read: ${data.length}`);

        const resultData = [];
        const usedPasswords = new Set();

        for (const row of data) {
            const {
                SL,
                applicant_id,
                Admission_roll,
                'Dept.Code': deptCode,
                Name,
                Current_Department
            } = row;

            // Validation: Skip rows missing essential ID or Roll
            if (applicant_id === undefined || Admission_roll === undefined) {
                console.warn(`Warning: Missing applicant_id or Admission_roll at SL: ${SL || 'Unknown'}. Skipping row.`);
                continue;
            }

            // Generate unique password
            let password;
            do {
                password = generatePassword(10);
            } while (usedPasswords.has(password));
            usedPasswords.add(password);

            // Create new row with specific column order
            resultData.push({
                "SL": SL,
                "applicant_id": applicant_id,
                "applicant_password": password,
                "Admission_roll": Admission_roll,
                "Dept.Code": deptCode,
                "Name": Name,
                "Current_Department": Current_Department
            });
        }

        // Define column order for the output
        const headers = [
            "SL",
            "applicant_id",
            "applicant_password",
            "Admission_roll",
            "Dept.Code",
            "Name",
            "Current_Department"
        ];

        // Create new worksheet and workbook
        const newWorksheet = XLSX.utils.json_to_sheet(resultData, { header: headers });
        const newWorkbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, "Final List");

        // Write file
        const outputPath = path.join(__dirname, 'final_list_generated.xlsx');
        XLSX.writeFile(newWorkbook, outputPath);

        console.log(`Total rows written: ${resultData.length}`);
        console.log(`Output file path: ${outputPath}`);

    } catch (error) {
        console.error("An unexpected error occurred:");
        console.error(error.message);
        process.exit(1);
    }
}

main();
