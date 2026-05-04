const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dummy = path.join(__dirname, 'test_images', 'dummy.jpg');
// Ensure it exists
if (!fs.existsSync(dummy)) {
    if (!fs.existsSync(path.join(__dirname, 'test_images'))) fs.mkdirSync(path.join(__dirname, 'test_images'));
    fs.writeFileSync(dummy, 'dummy');
}

const out = execSync(`exiftool -a -G1 -s --system:all --composite:all -j "${dummy}"`);
console.log(out.toString());
