import fs from 'fs';
import path from 'path';

const publicDir = 'c:/Users/giaki/Downloads/bingo18-dashboard/bingo18-dashboard/public';
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

const rootReplacementRegex = /:root\s*\{[\s\S]*?\}/;
const newRoot = `:root {
  --bg: #0f172a; --bg2: #1e1b4b; 
  --panel: rgba(15, 23, 42, 0.45); --panel2: rgba(30, 41, 59, 0.55);
  --line: rgba(255,255,255,0.08); --line2: rgba(255,255,255,0.15); 
  --text: #f8fafc; --muted: #94a3b8;
  --teal: #38bdf8; --teal-soft: rgba(56,189,248,0.15); 
  --amber: #fbbf24; --amber-soft: rgba(251,191,36,0.15);
  --danger: #ef4444; --shadow: 0 20px 60px rgba(0,0,0,0.4); 
  --r1: 28px; --r2: 20px;
  --glass-bg: rgba(30, 41, 59, 0.45);
}`;

for (const file of files) {
  if (file === 'openai-judge.html') continue;

  const filePath = path.join(publicDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // 1. Replace the CSS variables
  content = content.replace(rootReplacementRegex, newRoot);

  // 2. Replace the body background grid (subtle dot pattern)
  content = content.replace(/rgba\(16,32,51,\.03\)/g, 'rgba(255,255,255,0.03)');
  // borders / box shadows
  content = content.replace(/rgba\(16,32,51,\.08\)/g, 'rgba(255,255,255,0.05)');
  content = content.replace(/rgba\(16,32,51,\.14\)/g, 'rgba(255,255,255,0.1)');
  content = content.replace(/rgba\(17,35,54,\.14\)/g, 'rgba(0,0,0,0.4)');
  
  // 3. Convert all hardcoded white transluscent backgrounds to dark UI glass
  content = content.replace(/rgba\(255,255,255,\.92\)/g, 'rgba(255,255,255,0.06)');
  content = content.replace(/rgba\(255,255,255,\.9\)/g, 'rgba(255,255,255,0.06)');
  content = content.replace(/rgba\(255,255,255,\.95\)/g, 'rgba(255,255,255,0.08)');
  content = content.replace(/rgba\(255,255,255,\.88\)/g, 'rgba(255,255,255,0.08)');
  content = content.replace(/rgba\(255,255,255,\.78\)/g, 'rgba(255,255,255,0.05)');
  content = content.replace(/rgba\(255,255,255,\.76\)/g, 'rgba(255,255,255,0.04)');
  content = content.replace(/rgba\(255,255,255,\.66\)/g, 'rgba(255,255,255,0.04)');
  content = content.replace(/rgba\(255,255,255,\.62\)/g, 'rgba(15,23,42,0.4)'); // specific items/panels, use deep blue glass
  
  // 4. In card::after (subtle shine)
  content = content.replace(/rgba\(255,255,255,\.28\)/g, 'rgba(255,255,255,0.06)');

  // 5. Change body font family to match openai-judge.html
  content = content.replace(/font-family:\s*Bahnschrift[^;]+;/, "font-family: 'Inter', sans-serif;");
  
  // 6. In head, add Inter font
  if (!content.includes('Inter')) {
      content = content.replace('</head>', `  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">\n  </head>`);
  }
  
  // 7. Ambient blobs!
  if (!content.includes('ambient-blob')) {
      const blobStyles = `
      /* Ambient animated background blobs */
      .ambient-blob { position: fixed; border-radius: 50%; filter: blur(120px); z-index: -1; opacity: 0.6; animation: float 20s infinite alternate linear; pointer-events: none; }
      .blob-1 { top: -10%; left: -10%; width: 40vw; height: 40vw; background: rgba(56, 189, 248, 0.2); }
      .blob-2 { bottom: -10%; right: -10%; width: 50vw; height: 50vw; background: rgba(99, 102, 241, 0.15); animation-delay: -10s; }
      .blob-3 { top: 40%; left: 60%; width: 30vw; height: 30vw; background: rgba(168, 85, 247, 0.15); animation-direction: alternate-reverse; }
      @keyframes float { 0% { transform: translate(0, 0) scale(1); } 100% { transform: translate(10%, 15%) scale(1.1); } }
`;
      content = content.replace('</style>', blobStyles + '    </style>');
      
      const blobsHtml = `
  <div class="ambient-blob blob-1"></div>
  <div class="ambient-blob blob-2"></div>
  <div class="ambient-blob blob-3"></div>`;
      content = content.replace('<div class="app">', blobsHtml + '\n    <div class="app">');
  }

  // 8. Brand Title color enhancement (Gradient text)
  content = content.replace('.brand-mark strong {', '.brand-mark strong { background: linear-gradient(to right, #fff, var(--teal)); -webkit-background-clip: text; color: transparent;');
  
  // Text color fixes for hardcoded dark things in old CSS
  content = content.replace(/color:\s*#143554/g, 'color: var(--text)');
  content = content.replace(/color:\s*#13324d/g, 'color: var(--text)');
  content = content.replace(/color:\s*#102033/g, 'color: var(--text)');
  
  // Make tabs menu darker
  content = content.replace('.tabs-menu {', '.tabs-menu { background: rgba(15,23,42,0.7); backdrop-filter: blur(16px);');
  content = content.replace('.tabs-handle {', '.tabs-handle { background: rgba(15,23,42,0.7); backdrop-filter: blur(16px);');

  // Change tab link hover and active state globally
  content = content.replace('.tab-link {', '.tab-link { background: rgba(255,255,255,0.05); color: var(--text-muted); border-color: transparent;');
  content = content.replace('.tab-link:hover {', '.tab-link:hover { background: rgba(255,255,255,0.1); color: var(--text); border-color: rgba(255,255,255,0.1);');
  content = content.replace('.tab-link.active {', '.tab-link.active { background: rgba(56,189,248,0.15); color: #fff; border-color: rgba(56,189,248,0.4); box-shadow: inset 0 0 20px rgba(56,189,248,0.1);');

  fs.writeFileSync(filePath, content);
  console.log('Updated ' + file);
}

console.log('Done mapping UI theme to all HTML files!');
