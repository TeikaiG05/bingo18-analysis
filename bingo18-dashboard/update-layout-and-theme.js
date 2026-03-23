import fs from 'fs';
import path from 'path';

const publicDir = 'c:/Users/giaki/Downloads/bingo18-dashboard/bingo18-dashboard/public';
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

const lightModeCss = `
:root[data-theme="light"] {
  --bg: #ecf2f6; --bg2: #dfe8ef; 
  --panel: rgba(255,255,255,.78); --panel2: rgba(255,255,255,.92);
  --line: rgba(16,32,51,.1); --line2: rgba(16,32,51,.18); 
  --text: #102033; --muted: #62768c;
  --teal: #0d7a85; --teal-soft: rgba(13,122,133,.12); 
  --amber: #c46c20; --amber-soft: rgba(196,108,32,.12);
  --danger: #be465f; --shadow: 0 20px 60px rgba(17,35,54,.12);
}

[data-theme="light"] .ambient-blob { display: none; }
[data-theme="light"] body::before {
   background-image:
     linear-gradient(rgba(16,32,51,.03) 1px, transparent 1px),
     linear-gradient(90deg, rgba(16,32,51,.03) 1px, transparent 1px);
}
[data-theme="light"] .tabs-menu, 
[data-theme="light"] .tabs-handle { background: rgba(255,255,255,0.9); border: 1px solid var(--line) !important; filter: none !important; backdrop-filter: none !important; }
[data-theme="light"] .card, 
[data-theme="light"] .bet-card { background: linear-gradient(180deg, var(--panel2), var(--panel)); backdrop-filter: blur(18px); }
[data-theme="light"] .card::after, [data-theme="light"] .bet-card::after { background: linear-gradient(135deg, rgba(255,255,255,.28), transparent 30%, transparent 70%, rgba(13,122,133,.06)); }
[data-theme="light"] .item, 
[data-theme="light"] .round-item, 
[data-theme="light"] .kpi, 
[data-theme="light"] .stat-box, 
[data-theme="light"] .hero-metric, 
[data-theme="light"] .prediction-focus, 
[data-theme="light"] .dice-panel, 
[data-theme="light"] .result-panel, 
[data-theme="light"] .summary-panel, 
[data-theme="light"] .analysis-panel, 
[data-theme="light"] .bet-hero { background: rgba(255,255,255,0.62); border: 1px solid rgba(16,32,51,0.08); backdrop-filter: blur(14px); }
[data-theme="light"] .pill, 
[data-theme="light"] .rule-pill, 
[data-theme="light"] .mini-link, 
[data-theme="light"] .status-pill { background: rgba(255,255,255,0.66); color: var(--text); border: 1px solid var(--line); }
[data-theme="light"] .tab-link { background: rgba(255,255,255,0.76); color: var(--text-muted); border: 1px solid var(--line); }
[data-theme="light"] .tab-link:hover { border-color: var(--line2); background: rgba(255,255,255,0.9); color: var(--text); }
[data-theme="light"] .tab-link.active { color: var(--teal); border-color: rgba(13,122,133,.2); background: var(--teal-soft); box-shadow: none; }
[data-theme="light"] .brand-badge img { box-shadow: 0 10px 24px rgba(17,35,54,.14); }
[data-theme="light"] .brand-mark strong { background: none; -webkit-background-clip: unset; color: var(--text); }
[data-theme="light"] .die { color: #13324d; border: 1px solid rgba(13,122,133,0.16); background: radial-gradient(circle at 25% 20%, rgba(255,255,255,0.95), transparent 28%), linear-gradient(145deg, rgba(13,122,133,0.12), rgba(196,108,32,0.12)), #fff; }

/* Structural Grid Sidebar Layout for Old Files */
.app {
  display: grid !important;
  grid-template-columns: 280px 1fr !important;
  gap: 24px !important;
  align-items: start !important;
  max-width: 1560px !important;
  margin: 0 auto !important;
  padding-top: 18px !important;
}
.tabs-drawer {
  position: sticky !important;
  top: 18px !important;
  transform: none !important;
  height: fit-content;
  z-index: 10;
  display: block !important;
}
.tabs-handle { display: none !important; }
.tabs-menu {
  border-radius: 20px !important;
  border-left: 1px solid var(--line) !important;
  min-width: 100% !important;
  box-sizing: border-box;
}
.main-column { margin-bottom: 0 !important; }
@media (max-width: 1024px) {
  .app { grid-template-columns: 1fr !important; }
  .tabs-drawer { position: static !important; }
}
`;

const toggleBtnHtml = `
<button id="themeToggleBtn" style="margin-top:20px; width:100%; border-radius:12px; border:1px solid var(--line); background:var(--panel2); color:var(--text); padding:12px; cursor:pointer; font-family:inherit; font-weight:600; display:flex; align-items:center; justify-content:center; gap:8px; transition: all 0.2s;">
  <span id="themeIcon">☀️</span> <span>Giao diện Sáng/Tối</span>
</button>
<script>
  (function() {
    const savedTheme = localStorage.getItem('bingo_theme') || 'dark';
    if(savedTheme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    
    document.addEventListener('DOMContentLoaded', () => {
      const btn = document.getElementById('themeToggleBtn');
      const icon = document.getElementById('themeIcon');
      if (savedTheme === 'light') icon.textContent = '🌙';
      if(btn) {
        btn.addEventListener('click', () => {
          const current = document.documentElement.getAttribute('data-theme') || 'dark';
          const next = current === 'light' ? 'dark' : 'light';
          document.documentElement.setAttribute('data-theme', next);
          localStorage.setItem('bingo_theme', next);
          icon.textContent = next === 'light' ? '🌙' : '☀️';
        });
      }
    });
  })();
</script>
`;

for (const file of files) {
  const filePath = path.join(publicDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  if (!content.includes('data-theme="light"')) {
    content = content.replace('</style>', lightModeCss + '\n    </style>');
  }

  if (!content.includes('themeToggleBtn')) {
    if (content.includes('<div class="tabs-menu">')) {
       if(content.includes('<a class="tab-link" href="/bingo18-top3">Top 3 xúc xắc</a>')) {
           content = content.replace('<a class="tab-link" href="/bingo18-top3">Top 3 xúc xắc</a>', 
                   '<a class="tab-link" href="/bingo18-top3">Top 3 xúc xắc</a>\n' + toggleBtnHtml);
       } else if (content.includes('<a class="tab-link" href="/bingo18-top3">Top 3 Xúc Xắc</a>')) {
           content = content.replace('<a class="tab-link" href="/bingo18-top3">Top 3 Xúc Xắc</a>', 
                   '<a class="tab-link" href="/bingo18-top3">Top 3 Xúc Xắc</a>\n' + toggleBtnHtml);
       }
    } 
    if (content.includes('<nav class="nav-links">')) {
         content = content.replace('</nav>', toggleBtnHtml + '\n      </nav>');
    }
  }

  if (file === 'openai-judge.html') {
     const judgeLightModeCss = `
:root[data-theme="light"] {
  --bg-gradient-start: #f8fafc; --bg-gradient-end: #e2e8f0;
  --glass-bg: rgba(255, 255, 255, 0.75);
  --glass-border: rgba(16, 32, 51, 0.1);
  --text-main: #102033; --text-muted: #62768c;
  --glass-shadow: 0 10px 30px rgba(17,35,54,0.08);
  --accent-glow: #0ea5e9;
  --panel2: rgba(241, 245, 249, 0.9);
}
[data-theme="light"] .ambient-blob { display: none; }
[data-theme="light"] body { background: linear-gradient(135deg, var(--bg-gradient-start), var(--bg-gradient-end)); }
[data-theme="light"] .metric-card { background: rgba(255,255,255,0.6); border: 1px solid rgba(16,32,51,0.1); }
[data-theme="light"] .weight-name { color: #102033; }
[data-theme="light"] th { color: #62768c; }
[data-theme="light"] .notes-list li { color: #102033; }
[data-theme="light"] td { color: #102033; }
[data-theme="light"] #lblTopTotals { color: #102033 !important; }
[data-theme="light"] .nav-link:not(.active) { color: #62768c; }
[data-theme="light"] .brand-title { background: none; -webkit-background-clip: unset; color: var(--text-main); }
     `;
     if (!content.includes('judgeLightModeCss')) {
        content = content.replace('</style>', judgeLightModeCss + '\n    </style>');
     }
  }

  content = content.replace(/body\s*\{\s*margin: 0;\s*min-height: 100vh;\s*padding:\s*18px;/, 'body {\n        margin: 0; min-height: 100vh; padding: 0px;');
  
  fs.writeFileSync(filePath, content);
  console.log('Processed:', file);
}

console.log('Layout & Theme toggle completed globally!');
