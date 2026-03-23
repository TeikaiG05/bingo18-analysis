import fs from 'fs';
import path from 'path';

const publicDir = 'c:/Users/giaki/Downloads/bingo18-dashboard/bingo18-dashboard/public';
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

for (const file of files) {
  const filePath = path.join(publicDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Strip out the injected grid layout css safely
  const startMarker = '/* Structural Grid Sidebar Layout for Old Files */';
  const startIdx = content.indexOf(startMarker);
  
  if (startIdx !== -1) {
     const regex = /\/\*\s*Structural Grid Sidebar Layout for Old Files\s*\*\/[\s\S]*?\.tabs-drawer\s*\{\s*position:\s*static\s*!important;\s*\}\s*\}/m;
     if (regex.test(content)) {
        content = content.replace(regex, '');
        fs.writeFileSync(filePath, content);
        console.log('Reverted layout for:', file);
     } else {
        console.log('Regex failed to match end block for:', file);
     }
  }
}
console.log('Done!');
