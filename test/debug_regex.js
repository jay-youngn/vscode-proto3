
const line1 = "  map<string, string> properties = 10;";
const targetWord1 = "properties";
const regex1 = new RegExp(`^\\s*(optional|repeated|required)?\\s*(?:map\\s*<[^>]+>|\\w+(?:\\.(?:\\w+))*)\\s+(${targetWord1})\\s*=\\s*\\d+`, 'i');
console.log(`Line 1 match: ${regex1.test(line1)}`);

const line2 = "  repeated Employee employees = 2;";
const targetWord2 = "employees";
const regex2 = new RegExp(`^\\s*(optional|repeated|required)?\\s*(?:map\\s*<[^>]+>|\\w+(?:\\.(?:\\w+))*)\\s+(${targetWord2})\\s*=\\s*\\d+`, 'i');
console.log(`Line 2 match: ${regex2.test(line2)}`);

const line3 = "  string name = 2;";
const targetWord3 = "name";
const regex3 = new RegExp(`^\\s*(optional|repeated|required)?\\s*(?:map\\s*<[^>]+>|\\w+(?:\\.(?:\\w+))*)\\s+(${targetWord3})\\s*=\\s*\\d+`, 'i');
console.log(`Line 3 match: ${regex3.test(line3)}`);

// Test parseMessage field regex
const fieldRegex = /^\s*(optional|required|repeated)?\s*(?:(map)\s*<\s*([^<>]+)\s*,\s*([^<>]+)\s*>|(\w+(?:\.\w+)*))\s+(\w+)\s*=\s*(\d+)(?:\s*\[([\s\w=,]+)\])?\s*;(?:\s*\/\/\s*(.*))?$/;
console.log(`Parse Line 1 match: ${!!line1.match(fieldRegex)}`);
console.log(`Parse Line 2 match: ${!!line2.match(fieldRegex)}`);
