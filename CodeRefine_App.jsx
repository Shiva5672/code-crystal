import { useState, useEffect, useRef, useCallback } from "react";

// ── Anthropic API call (embedded backend) ──────────────────────────────────
async function analyzeCodeWithAI(code, language, focusAreas) {
  const focus = focusAreas.length ? focusAreas.join(", ") : "bugs, security, performance, style, maintainability";
  const langHint = language ? `Programming Language: ${language}` : "Auto-detect the programming language.";

  const prompt = `You are an expert senior code reviewer. Analyze the following code thoroughly.

${langHint}
Focus areas: ${focus}

Return ONLY a valid JSON object with exactly this structure (no markdown, no extra text):
{
  "language": "<detected language>",
  "summary": "<2-3 sentence overall assessment of code quality>",
  "score": <integer 0-100 representing code quality score>,
  "issues": [
    {
      "id": <number>,
      "issue_type": "<bug|security|performance|style|maintainability>",
      "severity": "<critical|high|medium|low|info>",
      "line_number": <integer or null>,
      "description": "<clear, specific explanation of the issue>",
      "suggestion": "<concrete fix with code example if possible>"
    }
  ],
  "optimized_code": "<complete rewritten and optimized version of the entire code>"
}

Code to analyze:
\`\`\`
${code}
\`\`\``;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = await response.json();
  const text = data.content?.[0]?.text || "";

  // Strip markdown fences if present
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(clean);
}

// ── Persistent storage helpers ─────────────────────────────────────────────
async function saveSession(session) {
  try {
    const key = `session:${session.id}`;
    await window.storage.set(key, JSON.stringify(session));
    // Update index
    let index = [];
    try {
      const res = await window.storage.get("sessions:index");
      if (res) index = JSON.parse(res.value);
    } catch {}
    if (!index.find((s) => s.id === session.id)) {
      index.unshift({ id: session.id, title: session.title, language: session.language, created_at: session.created_at, issue_count: session.issues?.length || 0, score: session.score });
      await window.storage.set("sessions:index", JSON.stringify(index.slice(0, 50)));
    }
  } catch (e) { console.error("Storage error:", e); }
}

async function loadSessions() {
  try {
    const res = await window.storage.get("sessions:index");
    return res ? JSON.parse(res.value) : [];
  } catch { return []; }
}

async function loadSession(id) {
  try {
    const res = await window.storage.get(`session:${id}`);
    return res ? JSON.parse(res.value) : null;
  } catch { return null; }
}

async function deleteSession(id) {
  try {
    await window.storage.delete(`session:${id}`);
    let index = [];
    try {
      const res = await window.storage.get("sessions:index");
      if (res) index = JSON.parse(res.value);
    } catch {}
    await window.storage.set("sessions:index", JSON.stringify(index.filter((s) => s.id !== id)));
  } catch {}
}

// ── Demo code ──────────────────────────────────────────────────────────────
const DEMO_CODE = `import sqlite3
import hashlib

def get_user(username):
    conn = sqlite3.connect('users.db')
    cursor = conn.cursor()
    query = "SELECT * FROM users WHERE username = '" + username + "'"
    cursor.execute(query)
    return cursor.fetchone()

def hash_password(password):
    return hashlib.md5(password.encode()).hexdigest()

def process_data(items):
    result = []
    for i in range(len(items)):
        for j in range(len(items)):
            if items[i] == items[j] and i != j:
                result.append(items[i])
    return result

DB_PASSWORD = "admin123"
API_KEY = "sk-1234567890abcdef"

def login(user, pwd):
    stored = get_user(user)
    if stored and stored[1] == pwd:
        return True
    return False`;

// ── Severity config ────────────────────────────────────────────────────────
const SEV = {
  critical: { color: "#ef4444", bg: "rgba(239,68,68,0.12)", label: "CRITICAL", icon: "🔴" },
  high:     { color: "#f97316", bg: "rgba(249,115,22,0.12)", label: "HIGH",     icon: "🟠" },
  medium:   { color: "#eab308", bg: "rgba(234,179,8,0.12)",  label: "MEDIUM",   icon: "🟡" },
  low:      { color: "#10b981", bg: "rgba(16,185,129,0.12)", label: "LOW",      icon: "🟢" },
  info:     { color: "#00e5ff", bg: "rgba(0,229,255,0.08)",  label: "INFO",     icon: "🔵" },
};
const TYPE_ICON = { bug: "🐛", security: "🔒", performance: "⚡", style: "✦", maintainability: "♻" };

// ── Main App ───────────────────────────────────────────────────────────────
export default function CodeRefineApp() {
  const [tab, setTab] = useState("review"); // review | history
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("");
  const [focusAreas, setFocusAreas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [expandedIssue, setExpandedIssue] = useState(null);
  const [toast, setToast] = useState(null);
  const [copyState, setCopyState] = useState({});
  const [activeView, setActiveView] = useState("split"); // split | diff
  const textareaRef = useRef(null);
  const resultsRef = useRef(null);

  useEffect(() => { loadSessions().then(setSessions); }, []);

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const copyText = useCallback(async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState((s) => ({ ...s, [key]: true }));
      setTimeout(() => setCopyState((s) => ({ ...s, [key]: false })), 2000);
      showToast("Copied!", "success");
    } catch { showToast("Copy failed", "error"); }
  }, [showToast]);

  const handleTabKey = (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = e.target.selectionStart;
      const val = e.target.value;
      e.target.value = val.substring(0, s) + "  " + val.substring(e.target.selectionEnd);
      e.target.selectionStart = e.target.selectionEnd = s + 2;
      setCode(e.target.value);
    }
  };

  const analyze = async () => {
    if (!code.trim()) { showToast("Paste some code first!", "error"); return; }
    setLoading(true);
    setResult(null);
    try {
      const data = await analyzeCodeWithAI(code, language, focusAreas);
      const session = {
        id: Date.now().toString(),
        title: `${data.language || "Code"} Review`,
        language: data.language,
        original_code: code,
        optimized_code: data.optimized_code,
        summary: data.summary,
        score: data.score,
        issues: data.issues || [],
        issue_counts: (data.issues || []).reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, {}),
        created_at: new Date().toISOString(),
      };
      setResult(session);
      await saveSession(session);
      setSessions(await loadSessions());
      showToast(`Analysis complete — ${session.issues.length} issue(s) found`, "success");
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (e) {
      showToast("Analysis failed: " + e.message, "error");
    } finally { setLoading(false); }
  };

  const openSession = async (id) => {
    const s = await loadSession(id);
    if (s) { setResult(s); setCode(s.original_code); setTab("review"); setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth" }), 100); }
  };

  const removeSession = async (id, e) => {
    e.stopPropagation();
    await deleteSession(id);
    setSessions(await loadSessions());
    if (result?.id === id) setResult(null);
    showToast("Session deleted", "success");
  };

  const downloadReport = () => {
    if (!result) return;
    const md = [
      `# CodeRefine Report — ${result.title}`,
      `**Date:** ${new Date(result.created_at).toLocaleString()}`,
      `**Language:** ${result.language}`,
      `**Score:** ${result.score}/100`,
      ``,`## Summary`,result.summary,``,
      `## Issues (${result.issues.length} total)`,
      ...result.issues.map((i,n) => `\n### ${n+1}. [${i.severity.toUpperCase()}] ${i.issue_type} — Line ${i.line_number||"N/A"}\n${i.description}\n**Fix:** ${i.suggestion}`),
      `\n## Optimized Code\n\`\`\`${result.language}\n${result.optimized_code}\n\`\`\``
    ].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = "coderefine-report.md"; a.click();
    showToast("Report downloaded!", "success");
  };

  const scoreColor = (s) => s >= 80 ? "#10b981" : s >= 60 ? "#eab308" : s >= 40 ? "#f97316" : "#ef4444";

  return (
    <div style={{ background: "#080810", minHeight: "100vh", color: "#e2e2f0", fontFamily: "'DM Sans', system-ui, sans-serif", position: "relative", overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #3a3a4a; }
        textarea { scrollbar-width: thin; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(24px); } to { opacity:1; transform:translateY(0); } }
        @keyframes slideIn { from { opacity:0; transform:translateX(-12px); } to { opacity:1; transform:translateX(0); } }
        @keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.4; transform:scale(0.75); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes glow { 0%,100% { opacity:0.5; } 50% { opacity:1; } }
        @keyframes scanline { 0% { transform:translateY(-100%); } 100% { transform:translateY(100vh); } }
        .fade-up { animation: fadeUp 0.5s ease both; }
        .slide-in { animation: slideIn 0.4s ease both; }
        .issue-card { transition: transform 0.2s, box-shadow 0.2s; }
        .issue-card:hover { transform: translateX(3px); }
        .btn-hover:hover { filter: brightness(1.15); transform: translateY(-1px); }
        .tab-active { border-bottom: 2px solid #00e5ff; color: #00e5ff; }
        .focus-chip { cursor:pointer; transition: all 0.2s; }
        .focus-chip:hover { border-color: #00e5ff !important; color: #00e5ff !important; }
        .session-row:hover { background: rgba(255,255,255,0.04) !important; }
        input:focus, select:focus, textarea:focus { outline: none; }
      `}</style>

      {/* Ambient blobs */}
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0 }}>
        <div style={{ position:"absolute", width:700, height:700, borderRadius:"50%", background:"rgba(0,229,255,0.04)", filter:"blur(120px)", top:-200, right:-150, animation:"glow 8s ease-in-out infinite" }} />
        <div style={{ position:"absolute", width:600, height:600, borderRadius:"50%", background:"rgba(124,58,237,0.05)", filter:"blur(120px)", bottom:-100, left:-100, animation:"glow 10s ease-in-out infinite 3s" }} />
      </div>

      {/* Scanline effect */}
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, overflow:"hidden", opacity:0.015 }}>
        <div style={{ position:"absolute", width:"100%", height:2, background:"rgba(0,229,255,0.8)", animation:"scanline 8s linear infinite" }} />
      </div>

      <div style={{ position:"relative", zIndex:1, maxWidth:1300, margin:"0 auto", padding:"0 20px" }}>

        {/* ── Header ── */}
        <header style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"20px 0", borderBottom:"1px solid #1e1e2e" }} className="fade-up">
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:42, height:42, borderRadius:12, background:"linear-gradient(135deg,#00e5ff,#7c3aed)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Bebas Neue',sans-serif", fontSize:22, color:"#000", boxShadow:"0 0 24px rgba(0,229,255,0.35)", letterSpacing:1 }}>CR</div>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:30, letterSpacing:3, lineHeight:1 }}>
              Code<span style={{ color:"#00e5ff" }}>Refine</span>
            </div>
            <div style={{ padding:"3px 10px", borderRadius:100, border:"1px solid rgba(0,229,255,0.3)", background:"rgba(0,229,255,0.06)", fontSize:10, color:"#00e5ff", fontFamily:"'JetBrains Mono',monospace", letterSpacing:1 }}>AI ENGINE v1.0</div>
          </div>
          <nav style={{ display:"flex", gap:4 }}>
            {["review","history"].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ padding:"8px 18px", background:"none", border:"none", color: tab===t ? "#00e5ff" : "#6b6b80", cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontSize:14, fontWeight:500, borderBottom: tab===t ? "2px solid #00e5ff" : "2px solid transparent", transition:"all 0.2s", letterSpacing:0.5 }}>
                {t.charAt(0).toUpperCase()+t.slice(1)} {t==="history" && sessions.length > 0 && <span style={{ marginLeft:4, background:"#1e1e2e", borderRadius:100, padding:"1px 7px", fontSize:10, color:"#6b6b80" }}>{sessions.length}</span>}
              </button>
            ))}
          </nav>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <button onClick={() => { setCode(DEMO_CODE); setLanguage("python"); showToast("Demo loaded — intentionally buggy Python!", "success"); setTab("review"); }} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #2a2a3a", background:"none", color:"#6b6b80", cursor:"pointer", fontSize:13, fontFamily:"'DM Sans',sans-serif", transition:"all 0.2s" }} className="btn-hover">Demo Code</button>
            <button onClick={analyze} disabled={loading} style={{ padding:"9px 22px", borderRadius:10, background:"linear-gradient(135deg,#00e5ff,#0099cc)", color:"#000", fontWeight:700, fontSize:13, border:"none", cursor:"pointer", fontFamily:"'DM Sans',sans-serif", boxShadow:"0 0 20px rgba(0,229,255,0.25)", opacity: loading ? 0.6 : 1, display:"flex", alignItems:"center", gap:8, transition:"all 0.2s" }} className="btn-hover">
              {loading && <div style={{ width:14, height:14, border:"2px solid rgba(0,0,0,0.3)", borderTopColor:"#000", borderRadius:"50%", animation:"spin 0.7s linear infinite" }} />}
              {loading ? "Analyzing…" : "⬡ Analyze"}
            </button>
          </div>
        </header>

        {/* ── REVIEW TAB ── */}
        {tab === "review" && (
          <>
            {/* Hero */}
            <div style={{ textAlign:"center", padding:"52px 0 44px" }} className="fade-up">
              <div style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"5px 14px", borderRadius:100, border:"1px solid rgba(0,229,255,0.25)", background:"rgba(0,229,255,0.04)", fontSize:11, color:"#00e5ff", fontFamily:"'JetBrains Mono',monospace", letterSpacing:1.5, marginBottom:20 }}>
                <span style={{ width:6, height:6, borderRadius:"50%", background:"#00e5ff", animation:"pulse 2s infinite", display:"inline-block" }} /> LIVE AI · MULTI-LANGUAGE · INSTANT FEEDBACK
              </div>
              <h1 style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:"clamp(60px,10vw,108px)", lineHeight:0.88, letterSpacing:3, marginBottom:20 }}>
                CODE<br/><span style={{ color:"#2a2a3a", WebkitTextStroke:"1px #3a3a4a" }}>REVIEW</span><br/><span style={{ color:"#00e5ff" }}>REFINED.</span>
              </h1>
              <p style={{ color:"#6b6b80", fontSize:15, maxWidth:480, margin:"0 auto", lineHeight:1.75 }}>
                Paste your code. The AI engine detects bugs, vulnerabilities, and performance issues — then delivers an optimized, production-ready version.
              </p>
            </div>

            {/* Controls */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10, flexWrap:"wrap", gap:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <span style={{ fontSize:10, color:"#6b6b80", fontFamily:"'JetBrains Mono',monospace", letterSpacing:1 }}>LANGUAGE:</span>
                <select value={language} onChange={e => setLanguage(e.target.value)} style={{ background:"#111120", border:"1px solid #2a2a3a", color:"#e2e2f0", fontFamily:"'JetBrains Mono',monospace", fontSize:12, padding:"7px 12px", borderRadius:8, cursor:"pointer" }}>
                  {["","python","javascript","typescript","java","c","cpp","go","rust","php","ruby","swift","kotlin","sql","bash"].map(l => <option key={l} value={l}>{l || "Auto-detect"}</option>)}
                </select>
                {result && (
                  <div style={{ display:"flex", borderRadius:8, border:"1px solid #2a2a3a", overflow:"hidden" }}>
                    {["split","diff"].map(v => <button key={v} onClick={() => setActiveView(v)} style={{ padding:"7px 14px", background: activeView===v ? "#1e1e2e" : "none", border:"none", color: activeView===v ? "#00e5ff" : "#6b6b80", cursor:"pointer", fontSize:12, fontFamily:"'JetBrains Mono',monospace", letterSpacing:0.5 }}>{v.toUpperCase()}</button>)}
                  </div>
                )}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <label style={{ padding:"7px 14px", borderRadius:8, border:"1px solid #2a2a3a", background:"none", color:"#6b6b80", cursor:"pointer", fontSize:12, fontFamily:"'JetBrains Mono',monospace" }}>
                  ⬆ FILE
                  <input type="file" accept=".py,.js,.ts,.java,.c,.cpp,.go,.rs,.php,.rb,.swift,.kt,.sql,.sh" style={{ display:"none" }} onChange={e => {
                    const f = e.target.files[0]; if (!f) return;
                    const r = new FileReader(); r.onload = ev => { setCode(ev.target.result); showToast(`Loaded: ${f.name}`, "success"); }; r.readAsText(f);
                    const extMap = { py:"python",js:"javascript",ts:"typescript",java:"java",c:"c",cpp:"cpp",go:"go",rs:"rust",php:"php",rb:"ruby",swift:"swift",kt:"kotlin",sql:"sql",sh:"bash" };
                    const ext = f.name.split(".").pop().toLowerCase(); if (extMap[ext]) setLanguage(extMap[ext]);
                  }} />
                </label>
                {code && <button onClick={() => { setCode(""); setResult(null); }} style={{ padding:"7px 14px", borderRadius:8, border:"1px solid #2a2a3a", background:"none", color:"#6b6b80", cursor:"pointer", fontSize:12, fontFamily:"'JetBrains Mono',monospace" }}>✕ CLEAR</button>}
              </div>
            </div>

            {/* Focus chips */}
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12, flexWrap:"wrap" }}>
              <span style={{ fontSize:10, color:"#6b6b80", fontFamily:"'JetBrains Mono',monospace", letterSpacing:1 }}>FOCUS:</span>
              {[["bug","🐛 Bugs"],["security","🔒 Security"],["performance","⚡ Performance"],["style","✦ Style"],["maintainability","♻ Maint."]].map(([val, label]) => {
                const active = focusAreas.includes(val);
                return <span key={val} className="focus-chip" onClick={() => setFocusAreas(f => active ? f.filter(x=>x!==val) : [...f,val])} style={{ padding:"5px 12px", borderRadius:100, border:`1px solid ${active ? "#00e5ff" : "#2a2a3a"}`, color: active ? "#00e5ff" : "#6b6b80", background: active ? "rgba(0,229,255,0.07)" : "none", fontSize:12, fontFamily:"'JetBrains Mono',monospace", userSelect:"none" }}>{label}</span>;
              })}
            </div>

            {/* Editor grid */}
            <div style={{ display:"grid", gridTemplateColumns: (result && activeView==="diff") ? "1fr" : "1fr 1fr", gap:2, border:"1px solid #1e1e2e", borderRadius:16, overflow:"hidden", background:"#1e1e2e", boxShadow:"0 0 60px rgba(0,0,0,0.6)", marginBottom:24 }}>
              {/* Input pane */}
              <div style={{ background:"#0d0d18", display:"flex", flexDirection:"column" }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 16px", background:"#111120", borderBottom:"1px solid #1e1e2e" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ width:10, height:10, borderRadius:"50%", background:"#ef4444", display:"inline-block" }} />
                    <span style={{ width:10, height:10, borderRadius:"50%", background:"#eab308", display:"inline-block" }} />
                    <span style={{ width:10, height:10, borderRadius:"50%", background:"#10b981", display:"inline-block" }} />
                    <span style={{ marginLeft:8, fontSize:10, color:"#6b6b80", fontFamily:"'JetBrains Mono',monospace", letterSpacing:1.5 }}>INPUT.{language||"code"}</span>
                  </div>
                  <button onClick={() => copyText(code, "input")} style={{ background:"none", border:"1px solid #2a2a3a", color:"#6b6b80", cursor:"pointer", padding:"4px 10px", borderRadius:6, fontSize:11, fontFamily:"'JetBrains Mono',monospace", transition:"all 0.2s" }}>{copyState.input ? "✓ COPIED" : "⎘ COPY"}</button>
                </div>
                <textarea ref={textareaRef} value={code} onChange={e => setCode(e.target.value)} onKeyDown={handleTabKey}
                  placeholder={"// Paste your code here or load a demo...\n// Ctrl+Enter to analyze\n\nfunction insecureLogin(user, pass) {\n  const q = `SELECT * FROM users WHERE user='${user}'`;\n  return db.query(q);\n}"}
                  spellCheck={false} autoComplete="off"
                  style={{ flex:1, minHeight:380, background:"transparent", border:"none", color:"#c8d3f5", fontFamily:"'JetBrains Mono',monospace", fontSize:13, lineHeight:1.75, padding:20, resize:"none", tabSize:2 }}
                  onKeyDown={e => { if ((e.ctrlKey||e.metaKey) && e.key==="Enter") { e.preventDefault(); analyze(); } handleTabKey(e); }}
                />
              </div>

              {/* Output pane — split view */}
              {(!result || activeView === "split") && (
                <div style={{ background:"#0d0d18", display:"flex", flexDirection:"column" }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 16px", background:"#111120", borderBottom:"1px solid #1e1e2e" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ width:10, height:10, borderRadius:"50%", background:"#ef4444", display:"inline-block" }} />
                      <span style={{ width:10, height:10, borderRadius:"50%", background:"#eab308", display:"inline-block" }} />
                      <span style={{ width:10, height:10, borderRadius:"50%", background:"#10b981", display:"inline-block" }} />
                      <span style={{ marginLeft:8, fontSize:10, color:"#10b981", fontFamily:"'JetBrains Mono',monospace", letterSpacing:1.5 }}>OPTIMIZED.{result?.language||"output"}</span>
                    </div>
                    {result && <button onClick={() => copyText(result.optimized_code, "output")} style={{ background:"none", border:"1px solid #2a2a3a", color:"#6b6b80", cursor:"pointer", padding:"4px 10px", borderRadius:6, fontSize:11, fontFamily:"'JetBrains Mono',monospace", transition:"all 0.2s" }}>{copyState.output ? "✓ COPIED" : "⎘ COPY"}</button>}
                  </div>
                  {result ? (
                    <pre style={{ flex:1, minHeight:380, margin:0, padding:20, fontFamily:"'JetBrains Mono',monospace", fontSize:13, lineHeight:1.75, color:"#6ee7b7", overflowY:"auto", whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{result.optimized_code}</pre>
                  ) : (
                    <div style={{ flex:1, minHeight:380, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12, color:"#2a2a3a" }}>
                      {loading ? (
                        <>
                          <div style={{ width:40, height:40, border:"3px solid #1e1e2e", borderTopColor:"#00e5ff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
                          <p style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:12, color:"#6b6b80", letterSpacing:1 }}>ANALYZING CODE…</p>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize:48, opacity:0.2 }}>⬡</div>
                          <p style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, letterSpacing:2 }}>OPTIMIZED CODE APPEARS HERE</p>
                          <p style={{ fontSize:11, color:"#3a3a4a" }}>Ctrl+Enter to analyze</p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Diff view — full width side by side */}
              {result && activeView === "diff" && (
                <div style={{ gridColumn:"1/-1", display:"grid", gridTemplateColumns:"1fr 1fr", gap:2, background:"#1e1e2e" }}>
                  {[["original","ORIGINAL",result.original_code,"#fca5a5","input_diff"],["optimized","OPTIMIZED",result.optimized_code,"#6ee7b7","output_diff"]].map(([k,label,src,color,ck]) => (
                    <div key={k} style={{ background:"#0d0d18" }}>
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 16px", background:"#111120", borderBottom:"1px solid #1e1e2e" }}>
                        <span style={{ fontSize:10, color, fontFamily:"'JetBrains Mono',monospace", letterSpacing:1.5 }}>{k==="original"?"✕":"✓"} {label}</span>
                        <button onClick={() => copyText(src, ck)} style={{ background:"none", border:"1px solid #2a2a3a", color:"#6b6b80", cursor:"pointer", padding:"4px 10px", borderRadius:6, fontSize:11, fontFamily:"'JetBrains Mono',monospace" }}>{copyState[ck]?"✓ COPIED":"⎘ COPY"}</button>
                      </div>
                      <pre style={{ margin:0, padding:20, fontFamily:"'JetBrains Mono',monospace", fontSize:12, lineHeight:1.75, color, overflowY:"auto", maxHeight:500, whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{src}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Analyze CTA */}
            <div style={{ display:"flex", justifyContent:"center", marginBottom:40 }}>
              <button onClick={analyze} disabled={loading} className="btn-hover" style={{ padding:"14px 56px", borderRadius:14, background:"linear-gradient(135deg,#00e5ff,#0077cc)", color:"#000", fontWeight:700, fontSize:16, border:"none", cursor:"pointer", fontFamily:"'DM Sans',sans-serif", boxShadow:"0 4px 32px rgba(0,229,255,0.3)", opacity: loading ? 0.7 : 1, display:"flex", alignItems:"center", gap:10, letterSpacing:0.5, transition:"all 0.3s" }}>
                {loading ? <><div style={{ width:18, height:18, border:"2px solid rgba(0,0,0,0.3)", borderTopColor:"#000", borderRadius:"50%", animation:"spin 0.7s linear infinite" }} /> Analyzing…</> : "⬡ Analyze & Optimize Code"}
              </button>
            </div>

            {/* ── Results ── */}
            {result && (
              <div ref={resultsRef} className="fade-up" style={{ paddingBottom:80 }}>
                {/* Results header */}
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:24 }}>
                  <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:34, letterSpacing:3 }}>ANALYSIS RESULTS</div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={downloadReport} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #2a2a3a", background:"none", color:"#6b6b80", cursor:"pointer", fontSize:12, fontFamily:"'JetBrains Mono',monospace" }} className="btn-hover">⬇ REPORT</button>
                    <button onClick={() => copyText(result.optimized_code, "final")} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #00e5ff", background:"rgba(0,229,255,0.06)", color:"#00e5ff", cursor:"pointer", fontSize:12, fontFamily:"'JetBrains Mono',monospace" }} className="btn-hover">{copyState.final ? "✓ COPIED" : "⎘ COPY CODE"}</button>
                  </div>
                </div>

                {/* Score + Summary */}
                <div style={{ display:"grid", gridTemplateColumns:"auto 1fr", gap:2, marginBottom:20, border:"1px solid #1e1e2e", borderRadius:16, overflow:"hidden" }}>
                  <div style={{ background:"#0d0d18", padding:"28px 32px", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4, borderRight:"1px solid #1e1e2e", minWidth:140 }}>
                    <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:64, lineHeight:1, color: scoreColor(result.score) }}>{result.score}</div>
                    <div style={{ fontSize:10, color:"#6b6b80", fontFamily:"'JetBrains Mono',monospace", letterSpacing:2 }}>QUALITY SCORE</div>
                    <div style={{ width:80, height:4, borderRadius:2, background:"#1e1e2e", marginTop:8, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${result.score}%`, background: scoreColor(result.score), transition:"width 1s ease" }} />
                    </div>
                  </div>
                  <div style={{ background:"#0d0d18", padding:"24px 28px" }}>
                    <div style={{ fontSize:10, color:"#00e5ff", fontFamily:"'JetBrains Mono',monospace", letterSpacing:1.5, marginBottom:10 }}>// AI SUMMARY · <span style={{ background:"rgba(0,229,255,0.08)", padding:"2px 8px", borderRadius:4, border:"1px solid rgba(0,229,255,0.2)" }}>{result.language?.toUpperCase()}</span></div>
                    <p style={{ color:"#9090a0", lineHeight:1.75, fontSize:14 }}>{result.summary}</p>
                    {/* Mini severity bar */}
                    <div style={{ display:"flex", gap:10, marginTop:16, flexWrap:"wrap" }}>
                      {Object.entries(result.issue_counts||{}).map(([sev, cnt]) => (
                        <div key={sev} style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 12px", borderRadius:100, border:`1px solid ${SEV[sev]?.color||"#333"}40`, background: SEV[sev]?.bg || "transparent", fontSize:12, color: SEV[sev]?.color||"#999", fontFamily:"'JetBrains Mono',monospace" }}>
                          {SEV[sev]?.icon} <strong style={{ fontSize:16, fontFamily:"'Bebas Neue',sans-serif" }}>{cnt}</strong> {sev}
                        </div>
                      ))}
                      {Object.keys(result.issue_counts||{}).length===0 && <span style={{ color:"#10b981", fontSize:12, fontFamily:"'JetBrains Mono',monospace" }}>✓ No issues found</span>}
                    </div>
                  </div>
                </div>

                {/* Issues list */}
                {result.issues.length > 0 && (
                  <div style={{ marginBottom:32 }}>
                    <div style={{ fontSize:10, color:"#6b6b80", fontFamily:"'JetBrains Mono',monospace", letterSpacing:2, marginBottom:14 }}>// ISSUES ({result.issues.length})</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {result.issues.map((issue, i) => {
                        const s = SEV[issue.severity] || SEV.info;
                        const open = expandedIssue === i;
                        return (
                          <div key={i} className="issue-card slide-in" style={{ animationDelay:`${i*0.04}s`, border:"1px solid #1e1e2e", borderRadius:12, overflow:"hidden", background:"#0d0d18", boxShadow: open ? `-3px 0 0 ${s.color}` : "none", transition:"box-shadow 0.2s" }}>
                            <div onClick={() => setExpandedIssue(open ? null : i)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"13px 18px", cursor:"pointer", userSelect:"none" }}>
                              <div style={{ display:"flex", alignItems:"center", gap:10, flex:1, minWidth:0 }}>
                                <span style={{ padding:"3px 9px", borderRadius:100, background:s.bg, color:s.color, fontSize:10, fontFamily:"'JetBrains Mono',monospace", letterSpacing:0.5, fontWeight:700, flexShrink:0 }}>{s.label}</span>
                                <span style={{ padding:"3px 9px", borderRadius:100, background:"#111120", border:"1px solid #2a2a3a", color:"#6b6b80", fontSize:10, fontFamily:"'JetBrains Mono',monospace", flexShrink:0 }}>{TYPE_ICON[issue.issue_type]||""} {issue.issue_type}</span>
                                <span style={{ fontSize:13, color:"#c8d3f5", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{issue.description}</span>
                              </div>
                              <div style={{ display:"flex", alignItems:"center", gap:12, flexShrink:0, marginLeft:12 }}>
                                {issue.line_number && <span style={{ fontSize:10, color:"#6b6b80", fontFamily:"'JetBrains Mono',monospace" }}>L{issue.line_number}</span>}
                                <span style={{ color:"#6b6b80", fontSize:12, transition:"transform 0.2s", display:"inline-block", transform: open?"rotate(180deg)":"none" }}>▼</span>
                              </div>
                            </div>
                            {open && (
                              <div style={{ padding:"0 18px 16px", borderTop:"1px solid #1e1e2e" }}>
                                <div style={{ marginTop:12, padding:"12px 16px", borderRadius:8, background:"rgba(16,185,129,0.05)", border:"1px solid rgba(16,185,129,0.15)" }}>
                                  <div style={{ fontSize:10, color:"#10b981", fontFamily:"'JetBrains Mono',monospace", letterSpacing:1.5, marginBottom:8 }}>// SUGGESTION</div>
                                  <p style={{ fontSize:13, color:"#6ee7b7", lineHeight:1.7 }}>{issue.suggestion}</p>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ── HISTORY TAB ── */}
        {tab === "history" && (
          <div style={{ padding:"40px 0 80px" }} className="fade-up">
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:28 }}>
              <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:36, letterSpacing:3 }}>REVIEW HISTORY</div>
              {sessions.length > 0 && <span style={{ fontSize:11, color:"#6b6b80", fontFamily:"'JetBrains Mono',monospace" }}>{sessions.length} session{sessions.length!==1?"s":""} stored locally</span>}
            </div>
            {sessions.length === 0 ? (
              <div style={{ textAlign:"center", padding:"80px 0", color:"#2a2a3a" }}>
                <div style={{ fontSize:52, marginBottom:16, opacity:0.4 }}>⬡</div>
                <p style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:12, letterSpacing:2 }}>NO SESSIONS YET</p>
                <p style={{ fontSize:13, color:"#3a3a4a", marginTop:8 }}>Analyze some code to see history here</p>
                <button onClick={() => setTab("review")} style={{ marginTop:20, padding:"9px 22px", borderRadius:10, background:"rgba(0,229,255,0.08)", border:"1px solid rgba(0,229,255,0.3)", color:"#00e5ff", cursor:"pointer", fontSize:13, fontFamily:"'JetBrains Mono',monospace" }}>→ START REVIEWING</button>
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {sessions.map((s, i) => (
                  <div key={s.id} className="session-row" onClick={() => openSession(s.id)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 20px", borderRadius:12, border:"1px solid #1e1e2e", cursor:"pointer", transition:"all 0.2s", animationDelay:`${i*0.03}s`, background:"#0d0d18" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:16 }}>
                      <div style={{ width:38, height:38, borderRadius:10, background:"#111120", border:"1px solid #2a2a3a", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Bebas Neue',sans-serif", fontSize:14, color:"#00e5ff", letterSpacing:1 }}>{s.language?.substring(0,2).toUpperCase()||"??"}</div>
                      <div>
                        <div style={{ fontSize:14, color:"#c8d3f5", fontWeight:500 }}>{s.title}</div>
                        <div style={{ fontSize:11, color:"#6b6b80", fontFamily:"'JetBrains Mono',monospace", marginTop:2 }}>{new Date(s.created_at).toLocaleString()} · {s.issue_count} issue{s.issue_count!==1?"s":""}</div>
                      </div>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                      {s.score !== undefined && <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:24, color: scoreColor(s.score) }}>{s.score}</div>}
                      <button onClick={(e) => removeSession(s.id, e)} style={{ width:30, height:30, borderRadius:8, border:"1px solid #2a2a3a", background:"none", color:"#6b6b80", cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.2s" }} onMouseEnter={e => { e.currentTarget.style.borderColor="#ef4444"; e.currentTarget.style.color="#ef4444"; }} onMouseLeave={e => { e.currentTarget.style.borderColor="#2a2a3a"; e.currentTarget.style.color="#6b6b80"; }}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <footer style={{ borderTop:"1px solid #1e1e2e", padding:"24px 0", textAlign:"center", color:"#3a3a4a", fontSize:11, fontFamily:"'JetBrains Mono',monospace", letterSpacing:1 }}>
          CODEREFINE · BUILT BY <span style={{ color:"#00e5ff" }}>CODE CRYSTAL</span> · AI-POWERED CODE REVIEW ENGINE
        </footer>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed", bottom:24, right:24, zIndex:9999, padding:"12px 20px", borderRadius:10, background:"#111120", border:`1px solid ${toast.type==="success"?"#10b981":"#ef4444"}`, color: toast.type==="success"?"#6ee7b7":"#fca5a5", fontSize:13, fontFamily:"'JetBrains Mono',monospace", boxShadow:"0 8px 30px rgba(0,0,0,0.6)", animation:"fadeUp 0.3s ease" }}>
          {toast.type==="success"?"✓":"✕"} {toast.msg}
        </div>
      )}
    </div>
  );
}
