import fs from 'fs';
import path from 'path';

const publicDir = 'c:/Users/giaki/Downloads/bingo18-dashboard/bingo18-dashboard/public';
const indexFilePath = path.join(publicDir, 'index.html');
const openaiFilePath = path.join(publicDir, 'openai-judge.html');

let indexContent = fs.readFileSync(indexFilePath, 'utf8');
let openaiContent = fs.readFileSync(openaiFilePath, 'utf8');

// --- 1. Get drawer HTML
const drawerStartIdx = indexContent.indexOf('<div class="tabs-drawer">');
const drawerEndMarker = '<div class="tabs-handle">Menu</div>\n      </div>';
const drawerEndMatch = indexContent.indexOf(drawerEndMarker);
let drawerHTML = indexContent.substring(drawerStartIdx, drawerEndMatch + drawerEndMarker.length);

drawerHTML = drawerHTML.replace('<a class="tab-link active" href="/">Trang chính</a>', '<a class="tab-link" href="/">Trang chính</a>');
drawerHTML = drawerHTML.replace('<a class="tab-link" href="/openai-judge">AI local/free</a>', '<a class="tab-link active" href="/openai-judge">AI local/free</a>');

// --- 2. Remove old aside sidebar in openai
const asideStartIdx = openaiContent.indexOf('<aside class="sidebar">');
const asideEndMarker = '</aside>';
const asideEndMatch = openaiContent.indexOf(asideEndMarker, asideStartIdx);
openaiContent = openaiContent.substring(0, asideStartIdx) + drawerHTML + openaiContent.substring(asideEndMatch + asideEndMarker.length);

// --- 3. Replace app-container grid setting
openaiContent = openaiContent.replace('grid-template-columns: 280px 1fr;', '/* grid-template-columns: 280px 1fr; */');

// --- 4. Get the drawer CSS from index.html
// Looking at index.html, the tabs-drawer css is injected natively or locally? 
// In index.html, it's defined near the top. Let's just hardcode the necessary CSS to inject.
const newCss = `
    .tabs-drawer {
      position: fixed;
      top: 18px;
      left: 0;
      z-index: 1000;
      display: flex;
      align-items: flex-start;
      transform: translateX(calc(-100% + 54px));
      transition: transform 0.24s ease;
    }
    .tabs-drawer:hover { transform: translateX(0); }
    .tabs-handle {
      background: rgba(15,23,42,0.7); backdrop-filter: blur(16px);
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 54px; min-height: 54px; border: 1px solid var(--glass-border); border-left: 0; border-radius: 0 18px 18px 0;
      background: rgba(255,255,255,0.06); box-shadow: var(--glass-shadow);
      color: var(--text-main); font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; writing-mode: vertical-rl; text-orientation: mixed;
    }
    .tabs-menu {
      background: rgba(15,23,42,0.7); backdrop-filter: blur(16px); display: grid; gap: 10px; min-width: 220px; padding: 12px;
      border: 1px solid var(--glass-border); border-left: 0; border-radius: 0 18px 18px 0; background: rgba(255,255,255,0.06); box-shadow: var(--glass-shadow);
    }
    .brand-badge { display: flex; align-items: center; gap: 12px; padding: 8px 6px 14px; border-bottom: 1px solid var(--glass-border); margin-bottom: 4px; }
    .brand-badge img { width: 42px; height: 42px; border-radius: 14px; box-shadow: 0 10px 24px rgba(0,0,0,0.4); }
    .brand-mark { display: grid; gap: 2px; }
    .brand-mark strong { background: linear-gradient(to right, #fff, var(--accent-glow)); -webkit-background-clip: text; color: transparent; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
    .brand-mark span { font-size: 11px; color: var(--text-muted); }
    .tab-link { background: rgba(255,255,255,0.05); border-color: transparent; display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--glass-border); color: var(--text-main); text-decoration: none; font-size: 12px; font-weight: 800; }
    .tab-link:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.1); transform: translateY(-1px); }
    .tab-link.active { background: var(--accent-glow-subtle); color: #fff; border-color: rgba(99, 102, 241, 0.4); box-shadow: inset 0 0 20px rgba(99, 102, 241, 0.1); }
`;
openaiContent = openaiContent.replace('</style>', newCss + '\n</style>');

fs.writeFileSync(openaiFilePath, openaiContent);
console.log('Synchronized openai-judge!');
