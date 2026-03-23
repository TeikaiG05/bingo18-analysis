import fs from 'fs';
import path from 'path';

const publicDir = 'c:/Users/giaki/Downloads/bingo18-dashboard/bingo18-dashboard/public';
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

const statusCssFix = `
      .status-hit, [class*="status-hit"] { color: #10b981 !important; font-weight: 700; }
      .status-miss, [class*="status-miss"] { color: #ef4444 !important; font-weight: 700; }
`;

for (const file of files) {
  const filePath = path.join(publicDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Fix hardcoded white backgrounds in dark mode standard CSS by stripping them
  // Look for .tabs-handle and .tabs-menu standard definitions
  content = content.replace(/(\.tabs-menu\s*\{[^}]*)background:\s*rgba\(255,\s*255,\s*255,\s*0\.92\);/g, '$1');
  content = content.replace(/(\.tabs-handle\s*\{[^}]*)background:\s*rgba\(255,\s*255,\s*255,\s*0\.92\);/g, '$1');
  content = content.replace(/(\.tab-link\s*\{[^}]*)background:\s*rgba\(255,\s*255,\s*255,\s*0\.76\);/g, '$1');
  
  // Fix Trúng / Trượt text coloring by wrapping it
  content = content.replace(/\$\{item\.hit \? 'Trúng' : 'Trượt'\}/g, '<span class="${item.hit ? \'status-hit\' : \'status-miss\'}">${item.hit ? \'Trúng\' : \'Trượt\'}</span>');
  content = content.replace(/\$\{item\.hit \? 'TRÚNG' : 'TRƯỢT'\}/g, '<span class="${item.hit ? \'status-hit\' : \'status-miss\'}">${item.hit ? \'TRÚNG\' : \'TRƯỢT\'}</span>');
  content = content.replace(/\$\{hit \? 'Trúng' : 'Trượt'\}/g, '<span class="${hit ? \'status-hit\' : \'status-miss\'}">${hit ? \'Trúng\' : \'Trượt\'}</span>');
  content = content.replace(/\$\{hit \? 'TRÚNG' : 'TRƯỢT'\}/g, '<span class="${hit ? \'status-hit\' : \'status-miss\'}">${hit ? \'TRÚNG\' : \'TRƯỢT\'}</span>');

  if (!content.includes('.status-hit {')) {
    content = content.replace('</style>', statusCssFix + '\n    </style>');
  }

  // Wrap raw elements in main-column for CSS grid to work properly
  // Find where tabs-drawer ends
  const drawerEndIndex = content.indexOf('</div>\n\n      <div class="card">');
  if (drawerEndIndex !== -1 && !content.includes('<div class="main-column"')) {
     // Wait, a better way is to use regex or split on `<div class="tabs-drawer">...</div>`
     // But `tabs-drawer` has nested divs (tabs-menu, tabs-handle).
     // Let's find `<div class="tabs-handle">Menu</div>\n      </div>`
     const handleEnd = '<div class="tabs-handle">Menu</div>\n      </div>';
     const handleEnd2 = '<div class="tabs-handle">Menu</div>\n\t\t\t</div>';
     let splitStr = '';
     if (content.includes(handleEnd)) splitStr = handleEnd;
     else if (content.includes(handleEnd2)) splitStr = handleEnd2;
     
     if (splitStr) {
       const parts = content.split(splitStr);
       if (parts.length === 2) {
         let remainder = parts[1];
         // Check if remainder immediately starts with `<div class="main-column"`
         // Skip leading whitespaces
         const trimmed = remainder.trim();
         if (!trimmed.startsWith('<div class="main-column"') && !trimmed.startsWith('<main class="main-content"')) {
           // We need to wrap everything until the closing tags of .app
           // Usually it ends with `</div>\n\n    <script>` or `</div>\n    <script>`
           const scriptTagStr = '<script>';
           const parts2 = remainder.split(scriptTagStr);
           if (parts2.length >= 2) {
              // The last `</div>` before `<script>` belongs to `.app`
              let htmlBeforeScript = parts2[0];
              // Reverse find the last </div>
              const lastDivIdx = htmlBeforeScript.lastIndexOf('</div>');
              if (lastDivIdx !== -1) {
                 const innerContent = htmlBeforeScript.substring(0, lastDivIdx);
                 const closingAppDiv = htmlBeforeScript.substring(lastDivIdx);
                 
                 const newInner = `\n      <div class="main-column" style="display:flex; flex-direction:column; gap:18px;">${innerContent}      </div>\n${closingAppDiv}`;
                 content = parts[0] + splitStr + newInner + scriptTagStr + parts2.slice(1).join(scriptTagStr);
              }
           }
         }
       }
     }
  }

  // Final fix: in `update-layout-and-theme.js` I added layout css but it might override Light theme or vice versa properly?
  // Make sure .app { padding-top: 18px } is present correctly, but it is.
  // One specific issue: `.tab-link` has `color: var(--text)` overwritten by `color: var(--text-muted);` in Light Mode? The dark mode `.tab-link` has color: #102033 if it's white.
  // On the screenshot, the tab links were very light. Dark mode text color should be `--text` (#f8fafc).
  // I replaced `background: rgba(255, 255, 255, 0.76);` above, but `color: var(--text)` might still be there for `.tab-link` which is correct, but the default tab link color in old CSS was `color: var(--text-muted)`.
  
  fs.writeFileSync(filePath, content);
  console.log('Processed Fixes:', file);
}

console.log('UI Fixes completed!');
