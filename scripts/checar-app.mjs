// Checagem antes de publicar: abre o app (index.html) num navegador escondido, com um banco FALSO
// (scripts/teste/fake_sb.js) cheio de dados de exemplo, passa por todas as abas em cada parte da fazenda
// e falha se alguma aba ficar em branco ou der erro de JavaScript.
// Uso: node scripts/checar-app.mjs        (roda sozinho antes do git push, pelo .git/hooks/pre-push)
// Precisa do Edge ou do Chrome instalado. Não usa nada da internet além do que o próprio app carrega.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const NAVS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const nav = NAVS.find((p) => fs.existsSync(p));
if (!nav) { console.error("checar-app: não achei Edge nem Chrome; checagem pulada."); process.exit(0); }

// página de teste: o index.html com o Supabase trocado pelo banco falso
let html = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8");
const cdn = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"]+"><\/script>/;
if (!cdn.test(html)) { console.error("checar-app: não achei o <script> do Supabase no index.html"); process.exit(1); }
html = html.replace(cdn, '<script src="fake_sb.js"></script>');
const arquivos = { "/": ["text/html; charset=utf-8", html], "/fake_sb.js": ["text/javascript", fs.readFileSync(path.join(RAIZ, "scripts/teste/fake_sb.js"))] };
for (const f of ["cotacoes.json", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"])
  if (fs.existsSync(path.join(RAIZ, f))) arquivos["/" + f] = [f.endsWith(".json") ? "application/json" : f.endsWith(".png") ? "image/png" : "application/manifest+json", fs.readFileSync(path.join(RAIZ, f))];
const srv = http.createServer((q, r) => { const a = arquivos[q.url.split("?")[0]]; if (!a) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "Content-Type": a[0] }); r.end(a[1]); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${srv.address().port}/`;

// navegador escondido com porta de depuração (protocolo do Chrome, sem bibliotecas)
const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "checar-app-"));
const porta = 9300 + Math.floor(Math.random() * 500);
const br = spawn(nav, ["--headless=new", `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`, "--no-first-run", "--disable-gpu", "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
const fim = (cod) => { try { br.kill(); } catch {} srv.close(); setTimeout(() => { try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {} process.exit(cod); }, 800); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let alvo;
for (let i = 0; i < 60 && !alvo; i++) { await espera(250); try { alvo = (await (await fetch(`http://127.0.0.1:${porta}/json/list`)).json()).find((t) => t.type === "page"); } catch {} }
if (!alvo) { console.error("checar-app: o navegador não abriu"); fim(1); }

const ws = new WebSocket(alvo.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let n = 0; const pend = new Map(), erros = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; erros.push(`${d.exception?.description || d.text}`.split("\n").slice(0, 3).join(" | ")); }
};
const cdp = (method, params = {}) => new Promise((ok) => { const id = ++n; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
const roda = async (fn, arg) => { const r = await cdp("Runtime.evaluate", { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) erros.push("teste: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value; };

await cdp("Runtime.enable");
await cdp("Page.enable");
await cdp("Page.navigate", { url });
await espera(2500);

// dados de exemplo (gravados no banco falso antes de entrar): 2 retiros + Sede + 2 arrendamentos, custos, cocho, pesagens, estação...
const relatorio = await roda(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms)), T = window.__T, agora = new Date().toISOString();
  const hoje = new Date().toISOString().slice(0, 10), mes = hoje.slice(0, 7);
  const ant = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
  const add = (t, id, d) => (T[t] = T[t] || []).push({ id, owner: "u1", created_at: agora, dados: d });
  T.config = [{ owner: "u1", created_at: agora, dados: { nome: "Fazenda Teste", kgArroba: 30, safraMes: 7, area: 400,
    retiros: [{ id: "sh", nome: "Retiro A", donos: [], area: 70, areaFase: {} }, { id: "sf", nome: "Retiro B", donos: [], area: 70, areaFase: {} },
      { id: "a1", nome: "Parceiro 1", arr: true, precoCab: 45, dia: 5, donos: [], area: 0, areaFase: {} }, { id: "a2", nome: "Parceiro 2", arr: true, precoCab: 160, dia: 5, donos: [], area: 0, areaFase: {} }],
    sede: { nome: "Sede", area: 260, areaFase: {} },
    pesagens: [{ id: "p1", lote: "garrotes", data: ant + "-01", peso: 250, cab: 50 }, { id: "p2", lote: "garrotes", data: hoje, peso: 280, cab: 50 },
      { id: "p3", lote: "recria a", retiro: "sh", data: ant + "-02", peso: 280, cab: 40 }, { id: "p4", lote: "recria a", retiro: "sh", data: hoje, peso: 300, cab: 40 }],
    lembretes: [], alertas: [], contas: [], notas: { [mes]: "anotação de teste" } } }];
  for (const [id, ret, cats] of [["", "", { matrizes: { cab: 100, peso: 450 }, bezerros: { cab: 60, peso: 120 }, m13_24: { cab: 50, peso: 300 }, po_vaca_cria: { cab: 20, peso: 480 }, leite_vaca: { cab: 15, peso: 400 }, leite_bezerro: { cab: 7, peso: 120 } }],
    ["sh_", "sh", { m13_24: { cab: 40, peso: 290 } }], ["sf_", "sf", { m25_36: { cab: 30, peso: 480 } }], ["a1_", "a1", { m13_24: { cab: 98, peso: 280 } }], ["a2_", "a2", { matrizes: { cab: 32, peso: 450 } }]])
    for (const m of [ant, mes]) add("fechamentos", id + m, { mes: m, cats, ...(ret ? { retiro: ret } : {}) });
  add("movimentos", "m1", { tipo: "nascimento", data: hoje, categoria: "bezerros", cab: 5, pesoMedio: 30 });
  add("movimentos", "m2", { tipo: "venda", data: hoje, categoria: "m25_36", cab: 10, pesoMedio: 550, modo: "carcaca", rend: 55, precoArroba: 300, valor: 30250, retiro: "sf" });
  add("movimentos", "m3", { tipo: "transfParte", data: ant + "-10", categoria: "m13_24", cab: 20, pesoMedio: 270, retiro: "", paraRet: "a1" });
  add("movimentos", "m4", { tipo: "morte", data: hoje, categoria: "bezerros", cab: 1 });
  add("desembolsos", "d1", { data: hoje, valor: 5000, item: "peao", grupo: "mao", centro: "geral", tipo: "custeio" });
  add("desembolsos", "d2", { data: hoje, valor: 2000, item: "combustivel", grupo: "maquinas", centro: "engorda", tipo: "custeio", retiro: "sh" });
  add("desembolsos", "d3", { data: hoje, valor: 4500, item: "arrendamento", grupo: "arrendamento", centro: "recria", tipo: "custeio", retiro: "a1" });
  add("desembolsos", "d4", { data: hoje, valor: 30000, item: "outros", grupo: "outros", centro: "geral", tipo: "investimento" });
  add("insumos", "ddg", { nome: "DDG", tipo: "ingrediente", unidade: "tonelada", kgUn: 1000, grupo: "nutricao" });
  add("insumos", "nuc", { nome: "Núcleo mineral", tipo: "ingrediente", unidade: "saco", kgUn: 30, grupo: "nutricao" });
  add("insumos", "mix", { nome: "Proteico recria", tipo: "proteico", unidade: "kg", kgUn: 1, grupo: "nutricao", formulacaoId: "proteico-ddg", metaTipo: "pv", metaMin: 0.3, metaMax: 0.5 });
  add("insumos", "vac", { nome: "Vacina aftosa", unidade: "dose", minimo: 10, grupo: "sanidade" });
  add("formulacoes", "proteico-ddg", { nome: "Proteico-energético recria (DDG + núcleo)", tipo: "proteico", ingredientes: [{ nome: "DDG", pct: 95, preco: 0 }, { nome: "Núcleo mineral", pct: 5, preco: 0 }] });
  add("estoque_movs", "e1", { tipo: "entrada", insumoId: "ddg", data: ant + "-05", qtd: 30, valor: 45000 });
  add("estoque_movs", "e2", { tipo: "entrada", insumoId: "nuc", data: ant + "-05", qtd: 10, valor: 900 });
  add("estoque_movs", "f1", { tipo: "saida", fornecimento: true, insumoId: "mix", data: hoje, qtd: 500, dias: 7, fase: "recria", lote: "garrotes", cab: 50, peso: 280 });
  add("estacoes", "es1", { nome: "Estação teste", dataDG: ant + "-01", cats: {}, nascidosVivos: 80, desmMachos: 40, desmFemeas: 38, pesoDesmMachos: 200, pesoDesmFemeas: 185, pesoVacas: 420 });
  add("engorda", "l1", { nome: "Lote teste", sistema: "semi", cab: 28, dataEntrada: ant + "-01", pesoEntrada: 450, aquisicao: 6000, nutricaoDia: 8, operacionalDia: 2, dataSaida: hoje, pesoSaida: 560, carcaca: 300, precoVenda: 300 });
  add("engorda", "l2", { nome: "garrotes", sistema: "semi", cab: 50, dataEntrada: ant + "-01", pesoEntrada: 250, aquisicao: 3000, formulacaoId: "proteico-ddg", consumoPV: 0.7, maoMes: 1500, operacionalDia: 0.5, somaPasto: true });
  add("adaptacoes", "ad1", { nome: "Garrotes", tipo: "proteico", fase: "recria", inicio: hoje, cab: 50, peso: 280 });

  const f = document.querySelector("#authForm"); f.email.value = "teste@teste.test"; f.senha.value = "segredo1"; f.requestSubmit(); await w(3500);
  const out = { vazias: [], vistas: 0 };
  const abas = () => [...new Set([...document.querySelectorAll("[data-tab]")].map((b) => b.dataset.tab).filter(Boolean))];
  const partes = ["", "sede", "sh", "a1", "a2"];
  for (const p of partes) {
    if (p === "a1" || p === "a2") document.querySelector("[data-arrtoggle]")?.click(), await w(200);
    const b = document.querySelector(`#retbar [data-ret="${p}"], [data-ret="${p}"]`); b?.click(); await w(400);
    for (const a of abas()) {
      document.querySelector(`[data-tab="${a}"]`)?.click(); await w(350);
      const v = document.querySelector("#v-" + a); out.vistas++;
      if (!v || v.innerHTML.trim().length < 80) out.vazias.push(`${a} (parte "${p || "fazenda toda"}")`);
      for (const e of [...(v?.querySelectorAll("[data-entry]") || [])].map((x) => x.dataset.entry)) { document.querySelector(`#v-${a} [data-entry="${e}"]`)?.click(); await w(150); }
    }
  }
  // diária: troca o mês; fechamento: troca o mês e usa o "+ somar"
  document.querySelector('[data-ret=""]')?.click(); await w(300);
  document.querySelector('[data-tab="custos"]')?.click(); await w(400);
  const s = document.querySelector("#diaMes"); if (s) { s.value = s.options[0].value; s.dispatchEvent(new Event("change", { bubbles: true })); await w(400); } else out.vazias.push("quadro da diária não apareceu");
  // engorda: lote com formulação mostra a diária calculada e a simulação; o formulário tem os campos novos
  document.querySelector('[data-tab="engorda"]')?.click(); await w(400);
  const card = [...document.querySelectorAll("#v-engorda article.card")].find((c) => c.querySelector("h3")?.textContent === "garrotes");
  if (!card || !/Diária: R/.test(card.textContent) || !/Simular o consumo/.test(card.textContent)) out.vazias.push("diária calculada do lote de engorda não apareceu");
  document.querySelector('#v-engorda [data-open="lote"][data-edit="l2"]')?.click(); await w(400);
  const fm = document.querySelector('form [name="consumoPV"]'); if (!fm || fm.value !== "0.7") out.vazias.push("formulário do lote sem o consumo em % do PV");
  return out;
});

await espera(500);
const ruins = [...(relatorio?.vazias || []).map((x) => "aba em branco: " + x), ...[...new Set(erros)].map((x) => "erro: " + x)];
if (!relatorio) ruins.push("o teste não terminou");
if (ruins.length) {
  console.error(`\n✗ checar-app: ${ruins.length} problema(s) — NÃO publique assim:\n  - ` + ruins.slice(0, 15).join("\n  - "));
  fim(1);
} else {
  console.log(`✓ checar-app: ${relatorio.vistas} telas abertas (todas as abas em 5 partes da fazenda), nenhum erro.`);
  fim(0);
}
