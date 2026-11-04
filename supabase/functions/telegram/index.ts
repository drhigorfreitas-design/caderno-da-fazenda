// Caderno da Fazenda: robô do Telegram (função "telegram" do Supabase)
// Recebe foto de nota fiscal, texto ou anotação de um sócio, pede ao Claude para ler
// e lança na fazenda dele: custo em "desembolsos" ou anotação no bloco de notas do mês.
// Segredos (Edge Functions → Secrets): TELEGRAM_BOT_TOKEN e ANTHROPIC_API_KEY.
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY o próprio Supabase fornece.
// Depois de publicar, abra .../functions/v1/telegram?setup=1 uma vez para ligar o webhook.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

/* ---------- tipos de custo: os mesmos do app (chave, nome, grupo do benchmark) ---------- */
const ITENS: [string, string, string][] = [
  ["peao", "Peão / funcionário fixo", "mao"], ["empreiteiro", "Empreiteiro", "mao"], ["diarista", "Diarista", "mao"],
  ["combustivel", "Combustível", "maquinas"], ["medicacao", "Medicamentos e vacinas", "sanidade"],
  ["suplementacao", "Suplementação e ração", "nutricao"], ["sal", "Sal mineral", "nutricao"],
  ["reproducao", "Sêmen e protocolos de IATF", "reproducao"], ["pasto", "Adubo, semente e reforma de pasto", "pastagem"],
  ["arrendamento", "Arrendamento", "arrendamento"], ["cercas", "Cercas, curral e benfeitorias", "manutencao"],
  ["maquinas", "Manutenção de máquinas e veículos", "maquinas"], ["energia", "Energia elétrica", "administracao"],
  ["admin", "Contador, escritório e internet", "administracao"], ["impostos", "Impostos e taxas", "impostos"],
  ["frete", "Frete e comissões", "outros"], ["outros", "Outros gastos", "outros"],
];
const ITN = Object.fromEntries(ITENS.map((i) => [i[0], i[1]]));
const ITG = Object.fromEntries(ITENS.map((i) => [i[0], i[2]]));
const ONDE: Record<string, string> = { geral: "Fazenda toda", cria: "Cria", recria: "Recria", engorda: "Engorda" };
/* rebanho: as mesmas categorias e tipos de movimento do app */
const CATS: Record<string, string> = { matrizes: "Matrizes", descarte: "Matrizes de descarte", bezerros: "Bezerros mamando", touros: "Touros",
  f8_12: "Fêmeas 8 a 12 meses", f13_24: "Fêmeas 13 a 24 meses", f24: "Fêmeas > 24 meses",
  m8_12: "Machos 8 a 12 meses", m13_24: "Machos 13 a 24 meses", m25_36: "Machos 25 a 36 meses", m36: "Machos > 36 meses", outras: "Outras categorias" };
const TIPOS_MOV: Record<string, string> = { nascimento: "Nascimento", compra: "Compra", venda: "Venda", morte: "Morte", transferencia: "Mudança de categoria" };
const MESF = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/* ---------- utilidades ---------- */
const hojeMT = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Cuiaba" }).format(new Date()); // AAAA-MM-DD
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dBR = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const okData = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
async function segredoWebhook(token: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("caderno:" + token));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

/* ---------- o que o Claude devolve ---------- */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tipo", "data", "valor", "item", "onde", "descricao", "anotacao", "movimentos", "resposta"],
  properties: {
    tipo: { type: "string", enum: ["custo", "rebanho", "anotacao", "pergunta", "nao_entendi"] },
    data: { type: "string", description: "AAAA-MM-DD da compra; vazio se não aparecer" },
    valor: { type: "number", description: "valor total pago em reais; 0 se não for custo" },
    item: { type: "string", enum: ITENS.map((i) => i[0]) },
    onde: { type: "string", enum: Object.keys(ONDE) },
    descricao: { type: "string", description: "curta: o que foi comprado e de quem, ex.: 'Diesel S10 300 L · Posto Trevo'" },
    anotacao: { type: "string", description: "texto da anotação quando tipo = anotacao; vazio nos outros casos" },
    movimentos: {
      type: "array", description: "quando tipo = rebanho: um item por movimento; vazio nos outros casos",
      items: {
        type: "object", additionalProperties: false,
        required: ["mov", "data", "categoria", "para", "cab", "peso_medio", "preco_arroba", "valor", "obs"],
        properties: {
          mov: { type: "string", enum: Object.keys(TIPOS_MOV) },
          data: { type: "string", description: "AAAA-MM-DD; vazio se a mensagem não disser (usa hoje)" },
          categoria: { type: "string", enum: Object.keys(CATS), description: "categoria dos animais (na mudança de categoria: a de origem)" },
          para: { type: "string", enum: ["", ...Object.keys(CATS)], description: "só na mudança de categoria: a de destino; senão vazio" },
          cab: { type: "integer", description: "número de cabeças" },
          peso_medio: { type: "number", description: "kg vivo por cabeça; 0 se não disser" },
          preco_arroba: { type: "number", description: "só na venda: R$ por arroba; 0 se não disser" },
          valor: { type: "number", description: "compra: total pago; venda: total recebido; 0 se não disser ou nos outros tipos" },
          obs: { type: "string", description: "curta: sexo dos bezerros, causa da morte, comprador, vendedor… vazio se nada" },
        },
      },
    },
    resposta: { type: "string", description: "quando tipo = nao_entendi: uma frase curta pedindo o que falta" },
  },
};
const SISTEMA = `Você lê o que um pecuarista manda pelo Telegram para o caderno da fazenda dele (cria, recria e engorda de gado de corte, em Mato Grosso).
Classifique a mensagem:
- "custo": nota fiscal, cupom, recibo, boleto pago ou frase dizendo que gastou/pagou algo. Preencha data (da nota; se não houver, deixe vazio), valor TOTAL pago em reais, o tipo de custo (item) que melhor descreve a maior parte do valor, e uma descrição curta.
- "rebanho": nascimento, compra, venda, morte ou mudança de categoria de animais (ex.: "nasceram 5 bezerros machos", "morreu 1 vaca de picada de cobra", "vendi 20 bois de 540 kg a 310 a arroba", "comprei 30 garrotes por 90 mil", "desmamei 40 bezerros machos para a recria"). Preencha "movimentos", um item por movimento (uma mensagem pode ter vários). Se a compra ou venda também disser o valor, lance só como rebanho (o valor vai no movimento, não como custo).
  Categorias: ${Object.entries(CATS).map(([k, v]) => `${k} = ${v}`).join("; ")}.
  Nascimento é sempre "bezerros" (anote o sexo em obs). Vaca/matriz = matrizes; vaca de descarte/vaca gorda para abate = descarte; desmama/bezerro desmamado macho = m8_12, fêmea = f8_12; garrote ou novilho de 1 a 2 anos = m13_24; boi magro de 2 a 3 anos = m25_36; boi gordo/boi acima de 3 anos = m36; novilha de 1 a 2 anos = f13_24; novilha acima de 2 anos = f24. Se só disser "boi" sem idade, use m25_36 em compra e m36 em venda. Desmame = mudança de categoria de bezerros para m8_12 ou f8_12 (machos e fêmeas em itens separados).
- "anotacao": algo para lembrar e não é gasto nem movimento de animais (chuva, vacinação feita, observação do pasto, "anotar: ..."). Copie o texto em "anotacao", sem o "anotar:".
- "pergunta": quer saber algo dos dados da fazenda e não está lançando nada (ex.: "quantas vacas eu tenho", "quanto gastei de sal em outubro", "quantos bezerros nasceram esse ano"). Os outros campos ficam vazios/0; a resposta vem depois.
- "nao_entendi": não dá para saber o valor ou o que é. Em "resposta", peça em uma frase o que falta.
Tipos de custo (item): ${ITENS.map((i) => `${i[0]} = ${i[1]}`).join("; ")}.
Dicas: diesel/gasolina/óleo = combustivel; vacina, vermífugo, antibiótico = medicacao; ração, DDG, milho, núcleo, proteinado = suplementacao; sal mineral = sal; peça, pneu, conserto de trator/caminhonete = maquinas; arame, mourão, conserto de curral = cercas; salário de funcionário fixo = peao; diária = diarista.
"onde": cria, recria ou engorda só se a mensagem disser claramente o setor; senão "geral" (fazenda toda).
Responda só com o JSON pedido.`;

export type Mov = { mov: string; data: string; categoria: string; para: string; cab: number; peso_medio: number; preco_arroba: number; valor: number; obs: string };
export type Leitura = { tipo: string; data: string; valor: number; item: string; onde: string; descricao: string; anotacao: string; movimentos?: Mov[]; resposta: string };

/* ---------- dependências (trocadas por imitações nos testes) ---------- */
export type Deps = {
  token: string;
  tg: (metodo: string, corpo: Record<string, unknown>) => Promise<any>;
  baixa: (caminho: string) => Promise<Uint8Array>;
  le: (conteudo: any[]) => Promise<Leitura | null>;
  pensa: (sistema: string, texto: string) => Promise<string | null>; // responde perguntas com os dados
  db: any; // cliente supabase com a chave de serviço
};

/* ---------- respostas ---------- */
const responde = (d: Deps, chat: number, texto: string, extra: Record<string, unknown> = {}) =>
  d.tg("sendMessage", { chat_id: chat, text: texto, parse_mode: "HTML", ...extra });
const esc = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const botoesCusto = (id: string, onde: string) => ({
  reply_markup: { inline_keyboard: [
    Object.keys(ONDE).map((k) => ({ text: (k === onde ? "• " : "") + ONDE[k], callback_data: `onde:${id}:${k}` })),
    [{ text: "↩ Desfazer", callback_data: `apagar:${id}` }],
  ] },
});
const AJUDA = "Mande a <b>foto da nota</b> ou escreva, por exemplo:\n• <i>gastei 300 de vacina na recria</i>\n• <i>nasceram 5 bezerros machos</i>\n• <i>morreu 1 vaca de picada de cobra</i>\n• <i>vendi 20 bois de 540 kg a 310 a arroba</i>\n• <i>anotar: choveu 40 mm hoje</i>\nEu lanço no Caderno da Fazenda com o seu nome.\n\nTambém respondo perguntas: <i>quantas vacas eu tenho?</i> · <i>quanto gastei de sal em outubro?</i>";

/* ---------- ligar o Telegram a uma conta ---------- */
async function liga(d: Deps, chat: number, codigo: string, nome: string) {
  const { data: c } = await d.db.from("telegram_codigos").select("user_id,fazenda_id,expira").eq("codigo", codigo).maybeSingle();
  if (!c || new Date(c.expira) < new Date()) return responde(d, chat, "Código inválido ou vencido. No app, vá em <b>Mais → Sócios → Conectar meu Telegram</b> e use o código novo.");
  await d.db.from("telegram_contas").upsert({ chat_id: chat, user_id: c.user_id, fazenda_id: c.fazenda_id, nome_telegram: nome }, { onConflict: "chat_id" });
  await d.db.from("telegram_codigos").delete().eq("codigo", codigo);
  const { data: m } = await d.db.from("membros").select("nome,email").eq("fazenda_id", c.fazenda_id).eq("user_id", c.user_id).maybeSingle();
  return responde(d, chat, `Pronto, ${esc(m?.nome || nome)}! Seu Telegram está ligado ao Caderno da Fazenda.\n\n${AJUDA}`);
}

/* ---------- lançar ---------- */
async function lancaCusto(d: Deps, chat: number, conta: any, quem: string, L: Leitura) {
  const item = ITN[L.item] ? L.item : "outros", onde = ONDE[L.onde] ? L.onde : "geral";
  const data = okData(L.data) && L.data <= hojeMT() ? L.data : hojeMT();
  const id = crypto.randomUUID(), valor = Math.round(L.valor * 100) / 100;
  const dados = { data, valor, item, grupo: ITG[item], tipo: "custeio", descricao: L.descricao || "", centro: onde, loteId: "",
    criadoEm: new Date().toISOString(), porId: conta.user_id, por: quem, origem: "telegram" };
  const { error } = await d.db.from("desembolsos").insert({ id, fazenda_id: conta.fazenda_id, owner: conta.user_id, data, valor, item, grupo: ITG[item],
    centro: onde, lote_id: null, tipo: "custeio", dados });
  if (error) { console.error("insert desembolsos", error); return responde(d, chat, "Não consegui salvar agora. Tente de novo em instantes."); }
  return responde(d, chat, `✅ Lancei: <b>${esc(ITN[item])}</b> · <b>${brl(valor)}</b> · ${dBR(data)} · ${ONDE[onde]}` +
    (L.descricao ? `\n${esc(L.descricao)}` : "") + (okData(L.data) ? "" : "\n<i>A nota não tinha data: usei hoje.</i>") +
    "\nSe o setor estiver errado, toque nele abaixo.", botoesCusto(id, onde));
}
const nfBR = (v: number, c = 0) => v.toLocaleString("pt-BR", { maximumFractionDigits: c });
async function lancaRebanho(d: Deps, chat: number, conta: any, quem: string, movs: Mov[]) {
  const hoje = hojeMT(), base = crypto.randomUUID(), criadoEm = new Date().toISOString();
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const kgA = Number(cfg?.dados?.kgArroba) || 30;
  const linhas: any[] = [], txt: string[] = [];
  for (const m of movs) {
    const cab = Math.round(Number(m.cab) || 0);
    if (!TIPOS_MOV[m.mov] || cab <= 0) continue;
    const categoria = m.mov === "nascimento" ? "bezerros" : CATS[m.categoria] ? m.categoria : "outras";
    if (m.mov === "transferencia" && (!CATS[m.para] || m.para === categoria)) continue;
    const data = okData(m.data) && m.data <= hoje ? m.data : hoje;
    const peso = Number(m.peso_medio) > 0 ? Math.round(Number(m.peso_medio)) : 0;
    const x: Record<string, unknown> = { tipo: m.mov, data, categoria, cab, pesoMedio: peso, obs: String(m.obs || "").trim() };
    if (m.mov === "transferencia") x.para = m.para;
    let valor: number | null = null;
    if (m.mov === "venda") {
      x.precoArroba = Number(m.preco_arroba) > 0 ? +m.preco_arroba : 0;
      valor = Number(m.valor) > 0 ? +m.valor : (x.precoArroba as number) && peso ? cab * peso / kgA * (x.precoArroba as number) : 0;
    }
    if (m.mov === "compra") valor = Number(m.valor) > 0 ? +m.valor : 0;
    if (valor != null) x.valor = Math.round(valor * 100) / 100;
    const id = `${base}-${linhas.length + 1}`;
    linhas.push({ id, fazenda_id: conta.fazenda_id, owner: conta.user_id, data, tipo: m.mov, categoria, cab, valor: valor == null ? null : x.valor,
      dados: { ...x, criadoEm, porId: conta.user_id, por: quem, origem: "telegram" } });
    txt.push(`• <b>${TIPOS_MOV[m.mov]}</b> · ${nfBR(cab)} cab. · ${esc(CATS[categoria])}${m.mov === "transferencia" ? " → " + esc(CATS[m.para]) : ""}` +
      ` · ${dBR(data)}${peso ? ` · ${nfBR(peso)} kg` : ""}${x.valor ? " · " + brl(x.valor as number) : ""}${x.obs ? `\n   <i>${esc(x.obs as string)}</i>` : ""}`);
  }
  if (!linhas.length) return responde(d, chat, "Não entendi o movimento. Diga quantas cabeças e o que aconteceu, por exemplo: <i>nasceram 5 bezerros machos</i>.");
  const { error } = await d.db.from("movimentos").insert(linhas);
  if (error) { console.error("insert movimentos", error); return responde(d, chat, "Não consegui salvar agora. Tente de novo em instantes."); }
  return responde(d, chat, `✅ Lancei no rebanho:\n${txt.join("\n")}\nSe a categoria estiver errada, toque em Desfazer e mande de novo com mais detalhe.`,
    { reply_markup: { inline_keyboard: [[{ text: "↩ Desfazer", callback_data: `apagarm:${base}` }]] } });
}
async function lancaNota(d: Deps, chat: number, conta: any, quem: string, texto: string) {
  const hoje = hojeMT(), mes = hoje.slice(0, 7);
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const dados = cfg?.dados || {}, notas = { ...(dados.notas || {}) };
  const linha = `${hoje.slice(8, 10)}/${hoje.slice(5, 7)} (${quem}): ${texto.trim()}`;
  notas[mes] = notas[mes] ? notas[mes].replace(/\s+$/, "") + "\n" + linha : linha;
  const { error } = await d.db.from("config").upsert({ fazenda_id: conta.fazenda_id, dados: { ...dados, notas }, updated_at: new Date().toISOString() }, { onConflict: "fazenda_id" });
  if (error) { console.error("upsert config", error); return responde(d, chat, "Não consegui salvar a anotação agora. Tente de novo."); }
  return responde(d, chat, `📝 Anotei no bloco de notas de ${MESF[+mes.slice(5) - 1]}:\n<i>${esc(linha)}</i>`);
}

/* ---------- dados da fazenda (para o resumo e as perguntas) ---------- */
const somaDias = (s: string, n: number) => { const t = new Date(s + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
async function todos(d: Deps, tabela: string, fazenda: string, desde = "") {
  const out: any[] = [];
  for (let i = 0; ; i += 1000) {
    let q = d.db.from(tabela).select("dados").eq("fazenda_id", fazenda);
    if (desde) q = q.gte("data", desde);
    const { data, error } = await q.range(i, i + 999);
    if (error) { console.error("ler " + tabela, error); break; }
    out.push(...(data || []).map((r: any) => r.dados || {}));
    if (!data || data.length < 1000) break;
  }
  return out;
}
// mesmo cálculo do app: último fechamento + movimentos depois dele
function rebanhoHoje(fechs: any[], movs: any[]) {
  const base = [...fechs].filter((f) => f.mes && f.cats).sort((a, b) => (a.mes < b.mes ? -1 : 1)).pop();
  if (!base) return null;
  const cats: Record<string, number> = {};
  Object.keys(CATS).forEach((c) => (cats[c] = Number(base.cats[c]?.cab) || 0));
  movs.filter((x) => String(x.data || "").slice(0, 7) > base.mes).forEach((x) => {
    const n = Number(x.cab) || 0;
    if (x.tipo === "nascimento" || x.tipo === "compra") cats[x.categoria] = (cats[x.categoria] || 0) + n;
    else if (x.tipo === "venda" || x.tipo === "morte") cats[x.categoria] = (cats[x.categoria] || 0) - n;
    else if (x.tipo === "transferencia" && cats[x.para] != null) { cats[x.categoria] -= n; cats[x.para] += n; }
  });
  Object.keys(cats).forEach((c) => (cats[c] = Math.max(0, Math.round(cats[c]))));
  return { mes: base.mes, cats, total: Object.values(cats).reduce((a, b) => a + b, 0) };
}

/* ---------- resumo semanal (GitHub Actions chama ?resumo=1 toda segunda) ---------- */
export async function resumoSemanal(d: Deps) {
  const hoje = hojeMT(), dow = new Date(hoje + "T12:00:00Z").getUTCDay();
  if (dow !== 1) return "só às segundas";
  const ini = somaDias(hoje, -7), fim = somaDias(hoje, -1); // segunda a domingo da semana passada
  // uma vez por semana: se alguém chamar de novo, não manda repetido
  const { error: ja } = await d.db.from("telegram_updates").insert({ update_id: -Number(ini.replace(/-/g, "")) });
  if (ja) return "já enviado";
  const { data: contas } = await d.db.from("telegram_contas").select("chat_id,fazenda_id");
  const porFaz: Record<string, number[]> = {};
  (contas || []).forEach((c: any) => (porFaz[c.fazenda_id] ||= []).push(c.chat_id));
  let n = 0;
  for (const [faz, chats] of Object.entries(porFaz)) {
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", faz).maybeSingle();
    const movs = await todos(d, "movimentos", faz), fechs = await todos(d, "fechamentos", faz);
    const semana = movs.filter((x) => x.data >= ini && x.data <= fim);
    const gastos = (await todos(d, "desembolsos", faz, ini)).filter((x) => x.data <= fim);
    const cab = (t: string) => semana.filter((x) => x.tipo === t).reduce((a, x) => a + (Number(x.cab) || 0), 0);
    const val = (t: string) => semana.filter((x) => x.tipo === t).reduce((a, x) => a + (Number(x.valor) || 0), 0);
    const reb = [
      cab("nascimento") && `${nfBR(cab("nascimento"))} ${cab("nascimento") === 1 ? "nascimento" : "nascimentos"}`,
      cab("morte") && `${nfBR(cab("morte"))} ${cab("morte") === 1 ? "morte" : "mortes"}`,
      cab("venda") && `${nfBR(cab("venda"))} vendidos${val("venda") ? ` (${brl(val("venda"))})` : ""}`,
      cab("compra") && `${nfBR(cab("compra"))} comprados${val("compra") ? ` (${brl(val("compra"))})` : ""}`,
      cab("transferencia") && `${nfBR(cab("transferencia"))} mudaram de categoria`,
    ].filter(Boolean);
    const tot = gastos.reduce((a, x) => a + (Number(x.valor) || 0), 0), porItem: Record<string, number> = {};
    gastos.forEach((x) => (porItem[x.item] = (porItem[x.item] || 0) + (Number(x.valor) || 0)));
    const top = Object.entries(porItem).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${ITN[k] || "Outros"} ${brl(v)}`);
    const R = rebanhoHoje(fechs, movs);
    const txt = `📊 <b>Resumo da semana</b> · ${dBR(ini).slice(0, 5)} a ${dBR(fim)}${fz?.nome ? "\n" + esc(fz.nome) : ""}\n\n` +
      `🐄 <b>Rebanho:</b> ${reb.length ? reb.join(" · ") : "nenhum movimento lançado"}\n` +
      `💸 <b>Custos:</b> ${tot ? brl(tot) + (top.length ? `\n   ${esc(top.join(" · "))}` : "") : "nenhum custo lançado"}\n` +
      (R ? `\n<b>Rebanho hoje:</b> ${nfBR(R.total)} cabeças\n<i>Fechamento de ${MESF[+R.mes.slice(5) - 1]} + movimentos lançados depois.</i>` : "") +
      `\n\nPergunte o que quiser, ex.: <i>quantas vacas eu tenho?</i>`;
    for (const chat of chats) { await d.tg("sendMessage", { chat_id: chat, text: txt, parse_mode: "HTML" }); n++; }
  }
  return `enviado para ${n} conversa(s)`;
}

/* ---------- perguntas sobre os dados ---------- */
export async function contexto(d: Deps, faz: string) {
  const hoje = hojeMT(), desde = somaDias(hoje, -730);
  const movs = await todos(d, "movimentos", faz), fechs = await todos(d, "fechamentos", faz), gastos = await todos(d, "desembolsos", faz, desde);
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const R = rebanhoHoje(fechs, movs), notas = cfg?.dados?.notas || {};
  const CN = (k: string) => CATS[k] || k || "";
  const linhas = [
    `Hoje: ${hoje}. 1 @ = ${Number(cfg?.dados?.kgArroba) || 30} kg de peso vivo.`,
    R ? `REBANHO HOJE (fechamento de ${R.mes} + movimentos depois): total ${R.total} cabeças; ` +
      Object.entries(R.cats).filter(([, v]) => v).map(([k, v]) => `${CN(k)} ${v}`).join("; ") : "REBANHO HOJE: nenhum fechamento de mês lançado ainda.",
    "FECHAMENTOS DO MÊS (mês: categoria cabeças/peso médio kg):",
    ...[...fechs].sort((a, b) => (a.mes < b.mes ? -1 : 1)).slice(-13).map((f) => `${f.mes}: ` +
      Object.entries(f.cats || {}).map(([k, v]: any) => `${CN(k)} ${v.cab}/${v.peso || "?"}kg`).join("; ")),
    "MOVIMENTOS (data;tipo;categoria;para;cabeças;peso médio kg;valor R$;obs;quem):",
    ...movs.filter((x) => x.data >= desde).sort((a, b) => (a.data < b.data ? -1 : 1)).map((x) =>
      [x.data, TIPOS_MOV[x.tipo] || x.tipo, CN(x.categoria), x.para ? CN(x.para) : "", x.cab, x.pesoMedio || "", x.valor || "", x.obs || "", x.por || ""].join(";")),
    "CUSTOS, últimos 2 anos (data;tipo de custo;setor;valor R$;descrição;custeio ou investimento):",
    ...gastos.sort((a, b) => (a.data < b.data ? -1 : 1)).map((x) =>
      [x.data, ITN[x.item] || x.item || "", ONDE[x.centro] || "Fazenda toda", x.valor, x.descricao || "", x.tipo || "custeio"].join(";")),
    "BLOCO DE NOTAS (mês: texto):",
    ...Object.keys(notas).sort().slice(-12).map((m) => `${m}: ${String(notas[m]).replace(/\s*\n\s*/g, " | ")}`),
  ];
  return linhas.join("\n");
}
const SISTEMA_PERGUNTA = `Você responde, pelo Telegram, perguntas de um pecuarista (cria, recria e engorda em Mato Grosso) sobre os dados do caderno da fazenda dele, que vêm abaixo.
Use só esses dados. Faça as contas com cuidado (some, conte e filtre pelas datas certas). Se os dados não bastarem, diga em uma frase o que falta lançar no app.
Responda curto, em português, em texto simples: sem markdown, sem asteriscos, sem tabelas. Pode usar quebras de linha e "•" para listas. Números no formato brasileiro (1.234,50; R$ 1.234,50).`;
async function respondePergunta(d: Deps, chat: number, conta: any, pergunta: string) {
  await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
  const r = await d.pensa(SISTEMA_PERGUNTA, `DADOS DA FAZENDA\n${await contexto(d, conta.fazenda_id)}\n\nPERGUNTA: ${pergunta}`);
  return responde(d, chat, r ? esc(r.trim()) : "Não consegui responder agora. Tente de novo em instantes.");
}

/* ---------- botões (Desfazer / trocar setor) ---------- */
async function botao(d: Deps, q: any) {
  const chat = q.message?.chat?.id, [acao, id, onde] = String(q.data || "").split(":");
  const { data: conta } = await d.db.from("telegram_contas").select("user_id,fazenda_id").eq("chat_id", chat).maybeSingle();
  const fim = (t: string) => d.tg("answerCallbackQuery", { callback_query_id: q.id, text: t });
  if (!conta) return fim("Telegram não está ligado ao app.");
  if (acao === "apagarm" && /^[0-9a-f-]{36}$/.test(id)) {
    const { data: ms } = await d.db.from("movimentos").delete().eq("fazenda_id", conta.fazenda_id).like("id", id + "-%").select("id");
    if (!ms?.length) return fim("Esse lançamento já não existe.");
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `↩ Desfeito: ${ms.length > 1 ? ms.length + " movimentos saíram" : "o movimento saiu"} do rebanho no app.` });
    return fim("Lançamento apagado");
  }
  const { data: x } = await d.db.from("desembolsos").select("dados").eq("fazenda_id", conta.fazenda_id).eq("id", id).maybeSingle();
  if (!x) return fim("Esse lançamento já não existe.");
  if (acao === "apagar") {
    await d.db.from("desembolsos").delete().eq("fazenda_id", conta.fazenda_id).eq("id", id);
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML", text: `↩ Desfeito: ${esc(ITN[x.dados.item] || "custo")} · ${brl(+x.dados.valor || 0)} não está mais no app.` });
    return fim("Lançamento apagado");
  }
  if (acao === "onde" && ONDE[onde]) {
    await d.db.from("desembolsos").update({ centro: onde, dados: { ...x.dados, centro: onde } }).eq("fazenda_id", conta.fazenda_id).eq("id", id);
    const t = String(q.message.text || "").replace(/· (Fazenda toda|Cria|Recria|Engorda)\b/, "· " + ONDE[onde]);
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: t, ...botoesCusto(id, onde) });
    return fim("Agora em: " + ONDE[onde]);
  }
  return fim("");
}

/* ---------- mensagem ---------- */
export async function trata(d: Deps, up: any) {
  if (up.update_id != null) {
    const { error } = await d.db.from("telegram_updates").insert({ update_id: up.update_id });
    if (error) return; // já tratada (o Telegram reenviou)
  }
  if (up.callback_query) return botao(d, up.callback_query);
  const msg = up.message; if (!msg?.chat?.id) return;
  const chat = msg.chat.id, texto = String(msg.text || msg.caption || "").trim(), nomeTg = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  const cod = texto.match(/^(?:\/start\s+)?(\d{6})$/);
  if (cod) return liga(d, chat, cod[1], nomeTg);
  const { data: conta } = await d.db.from("telegram_contas").select("user_id,fazenda_id").eq("chat_id", chat).maybeSingle();
  if (!conta) return responde(d, chat, "Olá! Para usar o robô, ligue seu Telegram pelo app: <b>Mais → Sócios → Conectar meu Telegram</b>. Depois mande aqui o código de 6 números.");
  if (/^\/(start|ajuda|help)\b/i.test(texto)) return responde(d, chat, AJUDA);
  const { data: m } = await d.db.from("membros").select("nome,email").eq("fazenda_id", conta.fazenda_id).eq("user_id", conta.user_id).maybeSingle();
  if (!m) return responde(d, chat, "Você não faz mais parte desta fazenda no app. Peça para um sócio te convidar de novo.");
  const quem = m.nome || String(m.email || "").split("@")[0] || nomeTg || "sócio";

  // anotação direta, sem gastar com a inteligência artificial
  const an = texto.match(/^(?:anotar|anota|nota)\s*[:\-]\s*([\s\S]+)/i);
  if (an && !msg.photo && !msg.document) return lancaNota(d, chat, conta, quem, an[1]);

  // pergunta direta (termina com "?"): não precisa classificar antes
  if (texto.endsWith("?") && !msg.photo && !msg.document) return respondePergunta(d, chat, conta, texto);

  const conteudo: any[] = [];
  const foto = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
  const doc = msg.document && /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(msg.document.mime_type || "") ? msg.document : null;
  if (foto || doc) {
    const f = await d.tg("getFile", { file_id: (foto || doc).file_id });
    if (!f?.ok) return responde(d, chat, "Não consegui baixar o arquivo. Tente mandar de novo.");
    const b64 = btoa(Array.from(await d.baixa(f.result.file_path), (b) => String.fromCharCode(b)).join(""));
    const tipo = doc ? doc.mime_type : "image/jpeg";
    conteudo.push(tipo === "application/pdf" ? { type: "document", source: { type: "base64", media_type: tipo, data: b64 } }
      : { type: "image", source: { type: "base64", media_type: tipo, data: b64 } });
  } else if (msg.voice || msg.audio) {
    return responde(d, chat, "Ainda não entendo áudio. Mande por escrito ou a foto da nota.");
  } else if (!texto) {
    return responde(d, chat, AJUDA);
  }
  conteudo.push({ type: "text", text: `Hoje é ${hojeMT()}.` + (texto ? `\nMensagem: ${texto}` : "\n(só a imagem)") });
  await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
  const L = await d.le(conteudo);
  if (!L) return responde(d, chat, "Não consegui ler agora. Tente de novo em instantes ou lance pelo app.");
  if (L.tipo === "pergunta" && texto) return respondePergunta(d, chat, conta, texto);
  if (L.tipo === "rebanho" && L.movimentos?.length) return lancaRebanho(d, chat, conta, quem, L.movimentos);
  if (L.tipo === "anotacao" && L.anotacao.trim()) return lancaNota(d, chat, conta, quem, L.anotacao);
  if (L.tipo === "custo" && L.valor > 0) return lancaCusto(d, chat, conta, quem, L);
  return responde(d, chat, esc(L.resposta || "Não entendi. Mande a foto da nota ou escreva o valor e o que foi comprado."));
}

/* ---------- servidor ---------- */
if (typeof Deno !== "undefined") {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  // a chave foi salva no Supabase como ANTHOPIC_API_KEY (sem o R); aceita os dois nomes
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("ANTHOPIC_API_KEY") });
  // chave de serviço: a antiga (SUPABASE_SERVICE_ROLE_KEY) ou a nova (SUPABASE_SECRET_KEYS, um JSON {"default": "sb_secret_..."})
  const chaveServico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    (() => { try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0] || ""; } catch { return ""; } })();
  const db = createClient(Deno.env.get("SUPABASE_URL")!, chaveServico as string, { auth: { persistSession: false } });
  const tg = async (metodo: string, corpo: Record<string, unknown>) =>
    (await fetch(`https://api.telegram.org/bot${token}/${metodo}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) })).json();
  const baixa = async (caminho: string) => new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${token}/${caminho}`)).arrayBuffer());
  const le = async (conteudo: any[]): Promise<Leitura | null> => {
    try {
      const r = await anthropic.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // se o modelo recusar por engano, o próprio servidor tenta outro
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system: SISTEMA,
        messages: [{ role: "user", content: conteudo }],
      } as any);
      if (r.stop_reason === "refusal") { console.error("recusa", (r as any).stop_details); return null; }
      const t = r.content.find((b: any) => b.type === "text") as any;
      return t ? JSON.parse(t.text) : null;
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) console.error("ANTHROPIC_API_KEY inválida");
      else if (e instanceof Anthropic.RateLimitError) console.error("limite da API do Claude");
      else if (e instanceof Anthropic.APIError) console.error(`erro da API do Claude ${e.status}:`, e.message);
      else console.error("erro ao ler", e);
      return null;
    }
  };
  const pensa = async (sistema: string, texto: string): Promise<string | null> => {
    try {
      const r = await anthropic.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" }, // contas com os dados: um pouco mais de cuidado
        system: sistema,
        messages: [{ role: "user", content: texto }],
      } as any);
      if (r.stop_reason === "refusal") { console.error("recusa", (r as any).stop_details); return null; }
      return r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || null;
    } catch (e) {
      console.error("erro ao responder pergunta", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
      return null;
    }
  };
  const deps: Deps = { token, tg, baixa, le, pensa, db };

  Deno.serve(async (req) => {
    const url = new URL(req.url), segredo = await segredoWebhook(token);
    if (url.searchParams.has("setup")) {
      // liga o webhook do Telegram nesta função (abrir uma vez no navegador)
      if (!token) return new Response("Falta o segredo TELEGRAM_BOT_TOKEN.", { status: 500 });
      const alvo = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram`;
      const r = await tg("setWebhook", { url: alvo, secret_token: segredo, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
      const eu = await tg("getMe", {});
      return new Response(r.ok ? `Robô @${eu.result?.username} ligado. Pode fechar esta página.` : "Erro: " + JSON.stringify(r), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.searchParams.has("resumo")) {
      // chamado toda segunda pelo GitHub Actions; manda no máximo uma vez por semana
      try { return new Response(await resumoSemanal(deps)); } catch (e) { console.error("resumo", e); return new Response("erro", { status: 500 }); }
    }
    if (req.method !== "POST" || req.headers.get("x-telegram-bot-api-secret-token") !== segredo) return new Response("ok");
    try { await trata(deps, await req.json()); } catch (e) { console.error("falha", e); }
    return new Response("ok");
  });
}
