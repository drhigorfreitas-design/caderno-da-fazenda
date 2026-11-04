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
  required: ["tipo", "custos", "movimentos", "anotacao", "lembretes", "alertas", "pesagens", "resposta"],
  properties: {
    tipo: { type: "string", enum: ["lancamento", "pergunta", "nao_entendi"] },
    custos: {
      type: "array", description: "um item por gasto; vazio se não houver",
      items: {
        type: "object", additionalProperties: false,
        required: ["data", "valor", "item", "onde", "descricao", "retiro"],
        properties: {
          retiro: { type: "string", description: "nome do retiro se a mensagem disser que este item é de um retiro (ex.: 'despesa Santa Helena ...'); vazio = fazenda toda" },
          data: { type: "string", description: "AAAA-MM-DD da compra; vazio se não aparecer" },
          valor: { type: "number", description: "valor pago em reais" },
          item: { type: "string", enum: ITENS.map((i) => i[0]) },
          onde: { type: "string", enum: Object.keys(ONDE) },
          descricao: { type: "string", description: "curta: o que foi comprado e de quem, ex.: 'Diesel S10 300 L · Posto Trevo'" },
        },
      },
    },
    anotacao: { type: "string", description: "o que é para lembrar e não é gasto nem movimento de animais; vazio se não houver" },
    movimentos: {
      type: "array", description: "um item por movimento de animais; vazio se não houver",
      items: {
        type: "object", additionalProperties: false,
        required: ["mov", "data", "categoria", "para", "cab", "peso_medio", "preco_arroba", "valor", "obs", "retiro"],
        properties: {
          retiro: { type: "string", description: "nome do retiro se a mensagem disser que este item é de um retiro (ex.: 'despesa Santa Helena ...'); vazio = fazenda toda" },
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
    lembretes: {
      type: "array", description: "pedidos para o robô avisar num dia; vazio se não houver",
      items: {
        type: "object", additionalProperties: false, required: ["data", "texto"],
        properties: {
          data: { type: "string", description: "AAAA-MM-DD do dia em que é para avisar" },
          texto: { type: "string", description: "curto: do que lembrar, ex.: 'vacina da aftosa' ou 'pagar boleto do sal'" },
        },
      },
    },
    alertas: {
      type: "array", description: "pedidos de aviso do preço da arroba do boi gordo; vazio se não houver",
      items: {
        type: "object", additionalProperties: false, required: ["direcao", "valor"],
        properties: {
          direcao: { type: "string", enum: ["acima", "abaixo"] },
          valor: { type: "number", description: "R$ por arroba" },
        },
      },
    },
    pesagens: {
      type: "array", description: "pesagens de animais; vazio se não houver",
      items: {
        type: "object", additionalProperties: false, required: ["data", "lote", "cab", "peso_medio", "retiro"],
        properties: {
          retiro: { type: "string", description: "nome do retiro se a mensagem disser que este item é de um retiro (ex.: 'despesa Santa Helena ...'); vazio = fazenda toda" },
          data: { type: "string", description: "AAAA-MM-DD; vazio se a mensagem não disser (usa hoje)" },
          lote: { type: "string", description: "nome do lote como o pecuarista chama, em minúsculas (ex.: recria, engorda, lote 3, garrotes da baixada)" },
          cab: { type: "integer", description: "cabeças pesadas; 0 se não disser" },
          peso_medio: { type: "number", description: "kg vivo médio por cabeça" },
        },
      },
    },
    resposta: { type: "string", description: "quando tipo = nao_entendi: uma frase curta pedindo o que falta" },
  },
};
const SISTEMA = `Você lê o que um pecuarista manda pelo Telegram para o caderno da fazenda dele (cria, recria e engorda de gado de corte, em Mato Grosso).
Uma mensagem pode trazer várias coisas ao mesmo tempo (ex.: "gastei 300 de sal e 200 de diesel, nasceram 5 bezerros, morreu 1 vaca e choveu 30 mm"). Separe cada uma no lugar certo; nada pode ficar de fora nem ser lançado duas vezes.
tipo:
- "lancamento": a mensagem lança alguma coisa. Preencha o que houver em custos, movimentos, anotacao, lembretes, alertas e pesagens (o que não houver fica vazio).
- "pergunta": quer saber algo dos dados da fazenda e não está lançando nada (ex.: "quantas vacas eu tenho", "quanto gastei de sal em outubro", "quantos bezerros nasceram esse ano"). Tudo o mais fica vazio; a resposta vem depois.
- "nao_entendi": não dá para saber o que lançar. Em "resposta", peça em uma frase o que falta.
custos: cada gasto pago (nota fiscal, cupom, recibo, boleto pago, "gastei", "paguei"). Um item por gasto citado; numa foto de nota, um item com o valor TOTAL e o tipo que descreve a maior parte. data da nota (vazio se não houver), valor em reais, tipo de custo (item) e descrição curta. Gasto sem valor não entra: peça o valor em "resposta" e lance o resto.
movimentos: nascimento, compra, venda, morte ou mudança de categoria de animais (ex.: "nasceram 5 bezerros machos", "morreu 1 vaca de picada de cobra", "vendi 20 bois de 540 kg a 310 a arroba", "comprei 30 garrotes por 90 mil", "desmamei 40 bezerros machos para a recria"). Um item por movimento. Compra ou venda de animais vai só aqui, com o valor no movimento, nunca também em custos.
  Categorias: ${Object.entries(CATS).map(([k, v]) => `${k} = ${v}`).join("; ")}.
  Nascimento é sempre "bezerros" (anote o sexo em obs). Vaca/matriz = matrizes; vaca de descarte/vaca gorda para abate = descarte; desmama/bezerro desmamado macho = m8_12, fêmea = f8_12; garrote ou novilho de 1 a 2 anos = m13_24; boi magro de 2 a 3 anos = m25_36; boi gordo/boi acima de 3 anos = m36; novilha de 1 a 2 anos = f13_24; novilha acima de 2 anos = f24. Se só disser "boi" sem idade, use m25_36 em compra e m36 em venda. Desmame = mudança de categoria de bezerros para m8_12 ou f8_12 (machos e fêmeas em itens separados).
anotacao: o que é para lembrar e não é gasto nem movimento (chuva, vacinação feita, observação do pasto, "anotar: ..."), escrito de forma curta, sem o "anotar:". Várias observações vão juntas no mesmo texto, separadas por "; ".
lembretes: pedidos para o robô avisar num dia ("lembrar: vacina da aftosa dia 15/11", "me lembra de pagar o boleto do sal dia 20", "boleto do sal vence dia 20"). data = o dia citado; se só disser o número do dia, é o próximo dia com esse número a partir de hoje; "amanhã" = hoje + 1. Lembrete sem dia não entra: peça o dia em "resposta". O que vai para lembretes não vai também para anotacao.
alertas: pedidos de aviso do preço da arroba do boi gordo ("me avisa quando o boi passar de 320" = acima 320; "quando a arroba cair abaixo de 300" = abaixo 300).
pesagens: pesagem de animais ("pesei o lote da recria, média 280 kg", "pesei 40 garrotes do lote 3, deu 312 kg"). Um item por lote pesado, com o peso médio por cabeça (se disser o peso total e as cabeças, divida). Pesagem não é movimento nem anotação.
resposta: vazio quando deu para lançar tudo; se alguma parte ficou de fora por falta de informação, diga em uma frase o que faltou.
Tipos de custo (item): ${ITENS.map((i) => `${i[0]} = ${i[1]}`).join("; ")}.
Dicas: diesel/gasolina/óleo = combustivel; vacina, vermífugo, antibiótico = medicacao; ração, DDG, milho, núcleo, proteinado = suplementacao; sal mineral = sal; peça, pneu, conserto de trator/caminhonete = maquinas; arame, mourão, conserto de curral = cercas; salário de funcionário fixo = peao; diária = diarista.
"onde": cria, recria ou engorda só se a mensagem disser claramente o setor; senão "geral" (fazenda toda).
retiro (em cada custo, movimento e pesagem): a fazenda é dividida em retiros (os nomes vêm junto da mensagem), cada um com seu gado e suas contas. Quem manda avisa antes de qual retiro é ("despesa Santa Helena: ...", "Santa Faustina: nasceram 3 bezerros"). O retiro citado vale para os itens que vêm depois dele, até citar outro. Item sem retiro citado fica vazio: é da fazenda toda.
Responda só com o JSON pedido.`;

export type Mov = { retiro?: string; mov: string; data: string; categoria: string; para: string; cab: number; peso_medio: number; preco_arroba: number; valor: number; obs: string };
export type Custo = { retiro?: string; data: string; valor: number; item: string; onde: string; descricao: string };
export type Lembrete = { data: string; texto: string };
export type Alerta = { direcao: string; valor: number };
export type Pesagem = { retiro?: string; data: string; lote: string; cab: number; peso_medio: number };
export type Leitura = { tipo: string; custos?: Custo[]; movimentos?: Mov[]; anotacao?: string; lembretes?: Lembrete[]; alertas?: Alerta[]; pesagens?: Pesagem[]; resposta?: string };

/* ---------- dependências (trocadas por imitações nos testes) ---------- */
export type Deps = {
  token: string;
  tg: (metodo: string, corpo: Record<string, unknown>) => Promise<any>;
  baixa: (caminho: string) => Promise<Uint8Array>;
  le: (conteudo: any[]) => Promise<Leitura | null>;
  pensa: (sistema: string, texto: string) => Promise<string | null>; // responde perguntas com os dados
  guarda?: (caminho: string, bytes: Uint8Array, tipo: string) => Promise<boolean>; // foto da nota no Storage (pasta "notas")
  link?: (caminho: string) => Promise<string | null>; // link temporário para ver a foto
  usuario?: (token: string) => Promise<string | null>; // id de quem está logado no app
  transcreve?: (bytes: Uint8Array, nome: string) => Promise<string | null>; // áudio → texto (OpenAI); ausente se não houver a chave
  envia?: (chat: number, nome: string, bytes: Uint8Array, legenda: string) => Promise<any>; // manda um arquivo (backup)
  cotacao?: () => Promise<{ data: string; spot: number } | null>; // arroba do boi gordo (cotacoes.json do app)
  db: any; // cliente supabase com a chave de serviço
};

/* ---------- respostas ---------- */
const responde = (d: Deps, chat: number, texto: string, extra: Record<string, unknown> = {}) =>
  d.tg("sendMessage", { chat_id: chat, text: texto, parse_mode: "HTML", ...extra });
const esc = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
/* ---------- retiros: cada um tem o seu gado e as suas contas (config.dados.retiros; os mesmos padrões do app) ---------- */
export type Retiro = { id: string; nome: string; donos?: string[] };
const RET_PADRAO: Retiro[] = [{ id: "sh", nome: "Santa Helena", donos: [] }, { id: "sf", nome: "Santa Faustina", donos: [] }];
export const retirosDe = (D: any): Retiro[] => (Array.isArray(D?.retiros) ? D.retiros : RET_PADRAO);
const semAcento = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
// retiro citado na mensagem; sem citar nada, "" = fazenda toda (geral)
export function qualRetiro(rets: Retiro[], citado: string) {
  const c = semAcento(citado).replace(/^retiro\s+/, "");
  if (!c) return "";
  return (rets.find((r) => semAcento(r.nome) === c || semAcento(r.nome).includes(c) || c.includes(semAcento(r.nome))) || {} as Retiro).id || "";
}
export const GERAL = "Fazenda toda";
const nomeRet = (rets: Retiro[], id: string) => (id && rets.find((r) => r.id === id)?.nome) || GERAL;
// etiqueta no fim da linha de cada item ("· 🏠 Santa Helena"); o botão de retiro troca todas
const tagRet = (rets: Retiro[], id: string) => (rets.length ? ` · 🏠 ${esc(nomeRet(rets, id))}` : "");
// botões: trocar o setor (só quando a mensagem lançou um custo só), trocar o retiro e desfazer tudo o que a mensagem lançou
const botoes = (base: string, custoId = "", onde = "", rets: Retiro[] = [], ret = "") => ({
  reply_markup: { inline_keyboard: [
    ...(custoId ? [Object.keys(ONDE).map((k) => ({ text: (k === onde ? "• " : "") + ONDE[k], callback_data: `onde:${custoId}:${k}` }))] : []),
    ...(rets.length ? [[...rets.map((r) => ({ text: (r.id === ret ? "• " : "") + r.nome, callback_data: `ret:${base}:${r.id}` })),
      { text: (ret === "" ? "• " : "") + GERAL, callback_data: `ret:${base}:geral` }]] : []),
    [{ text: "↩ Desfazer", callback_data: `desf:${base}` }],
  ] },
});
const AJUDA = "Mande a <b>foto da nota</b> ou escreva. Pode juntar várias coisas numa mensagem só (sai mais barato), por exemplo: <i>gastei 300 de sal e 200 de diesel, nasceram 5 bezerros e choveu 30 mm</i>\n\nTambém pode mandar <b>áudio</b> 🎤 falando a mesma coisa.\n\nOutros exemplos:\n• <i>gastei 300 de vacina na recria</i>\n• <i>nasceram 5 bezerros machos</i>\n• <i>morreu 1 vaca de picada de cobra</i>\n• <i>vendi 20 bois de 540 kg a 310 a arroba</i>\n• <i>anotar: choveu 40 mm hoje</i>\n• <i>pesei o lote da recria, 40 cabeças, média 280 kg</i>\nEu lanço no Caderno da Fazenda com o seu nome.\n\n🏠 <b>Retiros:</b> diga antes de qual é: <i>despesa Santa Helena: 300 de sal</i> · <i>Santa Faustina: nasceram 3 bezerros</i>. Sem dizer o retiro, fica para a <b>fazenda toda</b>. Qualquer sócio lança em qualquer um. Para perguntar de um retiro: <i>dados Santa Faustina: quanto gastei em outubro?</i>\n\n⏰ <b>Lembretes:</b> <i>lembrar: vacina da aftosa dia 15/11</i> (aviso às 7h do dia)\n📈 <b>Arroba:</b> <i>me avisa quando o boi passar de 320</i>\nPara ver ou cancelar, mande <b>lembretes</b>. Para receber a cópia dos dados agora, mande <b>backup</b> (ela também chega toda segunda). Todo dia 1º chega o relatório do mês; para ver o do mês passado agora, mande <b>relatório</b>.\n\nTambém respondo perguntas: <i>quantas vacas eu tenho?</i> · <i>quanto gastei de sal em outubro?</i>";

/* ---------- ligar o Telegram a uma conta ---------- */
async function liga(d: Deps, chat: number, codigo: string, nome: string) {
  const { data: c } = await d.db.from("telegram_codigos").select("user_id,fazenda_id,expira").eq("codigo", codigo).maybeSingle();
  if (!c || new Date(c.expira) < new Date()) return responde(d, chat, "Código inválido ou vencido. No app, vá em <b>Mais → Sócios → Conectar meu Telegram</b> e use o código novo.");
  await d.db.from("telegram_contas").upsert({ chat_id: chat, user_id: c.user_id, fazenda_id: c.fazenda_id, nome_telegram: nome }, { onConflict: "chat_id" });
  await d.db.from("telegram_codigos").delete().eq("codigo", codigo);
  const { data: m } = await d.db.from("membros").select("nome,email").eq("fazenda_id", c.fazenda_id).eq("user_id", c.user_id).maybeSingle();
  return responde(d, chat, `Pronto, ${esc(m?.nome || nome)}! Seu Telegram está ligado ao Caderno da Fazenda.\n\n${AJUDA}`);
}

/* ---------- foto da nota (comprovante) ---------- */
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
async function guardaNota(d: Deps, fazenda: string, bytes: Uint8Array, tipo: string) {
  if (!d.guarda || !EXT[tipo]) return "";
  const caminho = `${fazenda}/${hojeMT().slice(0, 7)}/${crypto.randomUUID()}.${EXT[tipo]}`;
  return (await d.guarda(caminho, bytes, tipo)) ? caminho : "";
}
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); };

/* ---------- app: ler / ver a foto da nota (POST ?nota=ler ou ?nota=ver, com o login do app) ---------- */
export async function notaApp(d: Deps, acao: string, token: string, corpo: any): Promise<{ status: number; json: any }> {
  const uid = token && d.usuario ? await d.usuario(token) : null;
  if (!uid) return { status: 401, json: { erro: "Entre de novo no app." } };
  const fazenda = String(corpo?.fazenda || "");
  const { data: m } = await d.db.from("membros").select("user_id").eq("fazenda_id", fazenda).eq("user_id", uid).maybeSingle();
  if (!m) return { status: 403, json: { erro: "Você não é sócio desta fazenda." } };
  if (acao === "ver") {
    const caminho = String(corpo?.caminho || "");
    if (!caminho.startsWith(fazenda + "/") || caminho.includes("..")) return { status: 400, json: { erro: "Nota inválida." } };
    const url = d.link ? await d.link(caminho) : null;
    return url ? { status: 200, json: { url } } : { status: 404, json: { erro: "Não achei a foto." } };
  }
  if (acao !== "ler") return { status: 400, json: { erro: "?" } };
  const tipo = String(corpo?.tipo || "image/jpeg"), dados = String(corpo?.imagem || "");
  if (!EXT[tipo] || !dados || dados.length > 12_000_000) return { status: 400, json: { erro: "Foto inválida ou grande demais." } };
  const bytes = Uint8Array.from(atob(dados), (c) => c.charCodeAt(0));
  const caminho = await guardaNota(d, fazenda, bytes, tipo);
  if (!corpo?.ler) return caminho ? { status: 200, json: { caminho } } : { status: 500, json: { erro: "Não consegui guardar a foto." } };
  const L = await d.le([
    tipo === "application/pdf" ? { type: "document", source: { type: "base64", media_type: tipo, data: dados } }
      : { type: "image", source: { type: "base64", media_type: tipo, data: dados } },
    { type: "text", text: `Hoje é ${hojeMT()}.\n(foto de nota tirada no app: é um custo)` },
  ]);
  const C = (L?.custos || []).filter((c) => Number(c.valor) > 0), c0 = C[0];
  const leitura = c0 ? {
    data: okData(c0.data) && c0.data <= hojeMT() ? c0.data : "", valor: Math.round(C.reduce((a, c) => a + Number(c.valor), 0) * 100) / 100,
    item: ITN[c0.item] ? c0.item : "outros", onde: ONDE[c0.onde] ? c0.onde : "geral", descricao: C.map((c) => c.descricao).filter(Boolean).join(" · "),
  } : null;
  return { status: 200, json: { caminho, leitura, aviso: leitura ? "" : (L?.resposta || "Não consegui ler a nota. Preencha à mão.") } };
}

/* ---------- lançar (uma mensagem pode ter custos, movimentos e anotação juntos) ---------- */
const nfBR = (v: number, c = 0) => v.toLocaleString("pt-BR", { maximumFractionDigits: c });
const MSG_ANOTA = "📝 Anotei: ";
// acrescenta uma linha no bloco de notas do mês; devolve a linha ou "" se falhou
async function anota(d: Deps, conta: any, quem: string, texto: string) {
  const hoje = hojeMT(), mes = hoje.slice(0, 7);
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const dados = cfg?.dados || {}, notas = { ...(dados.notas || {}) };
  const linha = `${hoje.slice(8, 10)}/${hoje.slice(5, 7)} (${quem}): ${texto.trim().replace(/\s*\n\s*/g, " ")}`;
  notas[mes] = notas[mes] ? notas[mes].replace(/\s+$/, "") + "\n" + linha : linha;
  const { error } = await d.db.from("config").upsert({ fazenda_id: conta.fazenda_id, dados: { ...dados, notas }, updated_at: new Date().toISOString() }, { onConflict: "fazenda_id" });
  if (error) { console.error("upsert config", error); return ""; }
  return linha;
}
// Desfazer: tira a linha do bloco de notas (procura em todos os meses)
async function desanota(d: Deps, conta: any, linha: string) {
  if (!linha) return false;
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const dados = cfg?.dados || {}, notas = { ...(dados.notas || {}) };
  let achou = false;
  for (const mes of Object.keys(notas)) {
    const ls = String(notas[mes]).split("\n"), j = ls.lastIndexOf(linha);
    if (j >= 0) { ls.splice(j, 1); notas[mes] = ls.join("\n"); achou = true; break; }
  }
  if (!achou) return false;
  const { error } = await d.db.from("config").upsert({ fazenda_id: conta.fazenda_id, dados: { ...dados, notas }, updated_at: new Date().toISOString() }, { onConflict: "fazenda_id" });
  return !error;
}
// muda o config da fazenda em cima da versão atual do banco; fn devolve null quando não há o que mudar
async function mudaCfg(d: Deps, faz: string, fn: (dados: any) => any) {
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const novo = fn({ ...(cfg?.dados || {}) });
  if (!novo) return true;
  const { error } = await d.db.from("config").upsert({ fazenda_id: faz, dados: novo, updated_at: new Date().toISOString() }, { onConflict: "fazenda_id" });
  if (error) console.error("upsert config", error);
  return !error;
}
// pesagens: o mesmo lote escrito de jeitos diferentes ("Lote da Recria", "recria") vira a mesma chave
export const loteK = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/^(o|a)\s+/, "").replace(/^lote\s+(da|do|de|das|dos)\s+/, "").replace(/\s+/g, " ").trim();
// pesagem anterior do mesmo lote (antes da data)
// (com retiro: só as pesagens do mesmo retiro, porque o mesmo nome de lote pode existir nos dois)
const anterior = (lista: any[], lote: string, data: string, retiro?: string) =>
  lista.filter((p) => loteK(p.lote) === loteK(lote) && p.data < data && (retiro === undefined || (p.retiro || "") === (retiro || ""))).sort((a, b) => (a.data < b.data ? -1 : 1)).pop() || null;
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const LIMPA_ENVIADOS = 60; // dias que um lembrete já avisado fica guardado

async function lancaNota(d: Deps, chat: number, conta: any, quem: string, texto: string) {
  const linha = await anota(d, conta, quem, texto);
  if (!linha) return responde(d, chat, "Não consegui salvar a anotação agora. Tente de novo.");
  return responde(d, chat, `${MSG_ANOTA}${esc(linha)}`, botoes(crypto.randomUUID()));
}
async function lanca(d: Deps, chat: number, conta: any, quem: string, L: Leitura, nota = "") {
  const hoje = hojeMT(), base = crypto.randomUUID(), criadoEm = new Date().toISOString();
  const autor = { criadoEm, porId: conta.user_id, por: quem, origem: "telegram" };
  const txt: string[] = [], avisos: string[] = [];
  const cfgD = (await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle()).data?.dados || {};
  const kgA = Number(cfgD.kgArroba) || 30;
  // retiro de cada item: o citado na mensagem; sem citar, fazenda toda (sem "retiro" nos dados)
  const rets = retirosDe(cfgD), usados = new Set<string>();
  const rid = (x: any) => { const r = rets.length ? qualRetiro(rets, x?.retiro || "") : ""; usados.add(r); return r; };
  const RT = (r: string) => (r ? { retiro: r } : {});

  // custos
  const custos: any[] = [];
  for (const c of L.custos || []) {
    const valor = Math.round((Number(c.valor) || 0) * 100) / 100;
    if (valor <= 0) continue;
    const item = ITN[c.item] ? c.item : "outros", onde = ONDE[c.onde] ? c.onde : "geral";
    const data = okData(c.data) && c.data <= hoje ? c.data : hoje;
    if (!okData(c.data) && nota) avisos.push("A nota não tinha data: usei hoje.");
    const id = `${base}-c${custos.length + 1}`, r = rid(c);
    custos.push({ id, fazenda_id: conta.fazenda_id, owner: conta.user_id, data, valor, item, grupo: ITG[item], centro: onde, lote_id: null, tipo: "custeio",
      dados: { data, valor, item, grupo: ITG[item], tipo: "custeio", descricao: c.descricao || "", centro: onde, loteId: "", ...RT(r), ...autor, ...(nota && custos.length === 0 ? { nota } : {}) } });
    txt.push(`💸 <b>${esc(ITN[item])}</b> · <b>${brl(valor)}</b> · ${dBR(data)} · ${ONDE[onde]}${tagRet(rets, r)}${c.descricao ? `\n   <i>${esc(c.descricao)}</i>` : ""}`);
  }

  // movimentos do rebanho
  const movs: any[] = [];
  if (L.movimentos?.length) {
    for (const m of L.movimentos) {
      const cab = Math.round(Number(m.cab) || 0);
      if (!TIPOS_MOV[m.mov] || cab <= 0) continue;
      const categoria = m.mov === "nascimento" ? "bezerros" : CATS[m.categoria] ? m.categoria : "outras";
      if (m.mov === "transferencia" && (!CATS[m.para] || m.para === categoria)) continue;
      const data = okData(m.data) && m.data <= hoje ? m.data : hoje;
      const peso = Number(m.peso_medio) > 0 ? Math.round(Number(m.peso_medio)) : 0, r = rid(m);
      const x: Record<string, unknown> = { tipo: m.mov, data, categoria, cab, pesoMedio: peso, obs: String(m.obs || "").trim() };
      if (m.mov === "transferencia") x.para = m.para;
      let valor: number | null = null;
      if (m.mov === "venda") {
        x.precoArroba = Number(m.preco_arroba) > 0 ? +m.preco_arroba : 0;
        valor = Number(m.valor) > 0 ? +m.valor : (x.precoArroba as number) && peso ? cab * peso / kgA * (x.precoArroba as number) : 0;
      }
      if (m.mov === "compra") valor = Number(m.valor) > 0 ? +m.valor : 0;
      if (valor != null) x.valor = Math.round(valor * 100) / 100;
      movs.push({ id: `${base}-m${movs.length + 1}`, fazenda_id: conta.fazenda_id, owner: conta.user_id, data, tipo: m.mov, categoria, cab,
        valor: valor == null ? null : x.valor, dados: { ...x, ...RT(r), ...autor } });
      txt.push(`🐄 <b>${TIPOS_MOV[m.mov]}</b> · ${nfBR(cab)} cab. · ${esc(CATS[categoria])}${m.mov === "transferencia" ? " → " + esc(CATS[m.para]) : ""}` +
        ` · ${dBR(data)}${peso ? ` · ${nfBR(peso)} kg` : ""}${x.valor ? " · " + brl(x.valor as number) : ""}${tagRet(rets, r)}${x.obs ? `\n   <i>${esc(x.obs as string)}</i>` : ""}`);
    }
  }

  // lembretes (aviso às 7h do dia)
  const lembs: any[] = [];
  for (const l of L.lembretes || []) {
    const texto = String(l.texto || "").trim();
    if (!texto) continue;
    if (!okData(l.data) || l.data < hoje) { avisos.push(`O lembrete "${texto}" ficou sem dia: mande de novo dizendo o dia.`); continue; }
    lembs.push({ id: `${base}-l${lembs.length + 1}`, data: l.data, texto, porId: conta.user_id, por: quem, criadoEm });
    txt.push(`⏰ <b>Lembrete</b> · ${dBR(l.data)} · ${esc(texto)}`);
  }

  // avisos de preço da arroba
  const alts: any[] = [];
  if (L.alertas?.length) {
    const cot = d.cotacao ? await d.cotacao().catch(() => null) : null;
    for (const a of L.alertas) {
      const valor = Math.round((Number(a.valor) || 0) * 100) / 100, acima = a.direcao !== "abaixo";
      if (valor <= 0) continue;
      const hojeTxt = cot ? `a arroba está em ${brl(cot.spot)} (B3 à vista, pregão de ${dBR(cot.data).slice(0, 5)})` : "";
      if (cot && (acima ? cot.spot >= valor : cot.spot <= valor)) {
        avisos.push(`Não marquei o aviso de ${brl(valor)}: ${hojeTxt}, já ${acima ? "acima" : "abaixo"} desse valor. Mande outro valor.`);
        continue;
      }
      alts.push({ id: `${base}-a${alts.length + 1}`, direcao: acima ? "acima" : "abaixo", valor, porId: conta.user_id, por: quem, criadoEm });
      txt.push(`📈 <b>Aviso da arroba</b> · quando o boi gordo ${acima ? "passar de" : "cair abaixo de"} <b>${brl(valor)}</b>/@${hojeTxt ? `\n   <i>${hojeTxt}</i>` : ""}`);
    }
  }

  // pesagens: ganho de peso desde a pesagem anterior do mesmo lote e, se o lote for um setor, o custo da @ produzida
  const pes: any[] = [];
  for (const p of L.pesagens || []) {
    const peso = Math.round((Number(p.peso_medio) || 0) * 10) / 10, lote = String(p.lote || "").trim().toLowerCase();
    if (peso <= 0 || !lote) continue;
    const data = okData(p.data) && p.data <= hoje ? p.data : hoje, cab = Math.max(0, Math.round(Number(p.cab) || 0)), r = rid(p);
    const novo = { id: `${base}-p${pes.length + 1}`, data, lote, cab, peso, ...RT(r), porId: conta.user_id, por: quem, criadoEm };
    let linha = `⚖️ <b>Pesagem</b> · ${esc(lote)} · ${cab ? nfBR(cab) + " cab. · " : ""}${nfBR(peso, 1)} kg · ${dBR(data)}${tagRet(rets, r)}`;
    const ant = anterior([...(cfgD.pesagens || []), ...pes], lote, data, rets.length ? r : undefined);
    if (ant) {
      const n = dias(ant.data, data), gmd = (peso - ant.peso) / n;
      linha += `\n   GMD <b>${gmd.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg/dia</b> em ${n} dias (eram ${nfBR(ant.peso, 1)} kg em ${dBR(ant.data)})`;
      const setor = loteK(lote), nc = cab || ant.cab;
      if (ONDE[setor] && setor !== "geral" && gmd > 0 && nc) {
        const gasto = (await todos(d, "desembolsos", conta.fazenda_id, somaDias(ant.data, 1)))
          .filter((x) => x.data <= data && x.centro === setor && x.tipo !== "investimento" && (!rets.length || (x.retiro || "") === r)).reduce((s, x) => s + (Number(x.valor) || 0), 0);
        const arr = nc * (peso - ant.peso) / kgA;
        if (gasto > 0) linha += `\n   Custo da @ produzida: <b>${brl(gasto / arr)}</b> (${brl(gasto)} lançados na ${ONDE[setor]} ÷ ${nfBR(arr, 1)} @)`;
      }
    } else linha += "\n   <i>Primeira pesagem deste lote: na próxima eu calculo o ganho de peso.</i>";
    pes.push(novo);
    txt.push(linha);
  }

  const temNota = !!String(L.anotacao || "").trim();
  if (!custos.length && !movs.length && !lembs.length && !alts.length && !pes.length && !temNota)
    return responde(d, chat, esc([...avisos, L.resposta || ""].filter(Boolean).join(" ") || "Não entendi o que lançar. Escreva o valor e o que foi comprado, ou quantas cabeças e o que aconteceu."));

  // grava: se uma parte falhar, desfaz o que já entrou para não ficar pela metade
  if (custos.length) {
    const { error } = await d.db.from("desembolsos").insert(custos);
    if (error) { console.error("insert desembolsos", error); return responde(d, chat, "Não consegui salvar agora. Tente de novo em instantes."); }
  }
  if (movs.length) {
    const { error } = await d.db.from("movimentos").insert(movs);
    if (error) {
      console.error("insert movimentos", error);
      if (custos.length) await d.db.from("desembolsos").delete().eq("fazenda_id", conta.fazenda_id).like("id", base + "-%");
      return responde(d, chat, "Não consegui salvar agora. Tente de novo em instantes.");
    }
  }
  if (lembs.length || alts.length || pes.length) {
    const ok = await mudaCfg(d, conta.fazenda_id, (D) => ({ ...D,
      ...(lembs.length ? { lembretes: [...(D.lembretes || []), ...lembs] } : {}),
      ...(alts.length ? { alertas: [...(D.alertas || []), ...alts] } : {}),
      ...(pes.length ? { pesagens: [...(D.pesagens || []), ...pes] } : {}) }));
    if (!ok) {
      if (custos.length) await d.db.from("desembolsos").delete().eq("fazenda_id", conta.fazenda_id).like("id", base + "-%");
      if (movs.length) await d.db.from("movimentos").delete().eq("fazenda_id", conta.fazenda_id).like("id", base + "-%");
      return responde(d, chat, "Não consegui salvar agora. Tente de novo em instantes.");
    }
  }
  let linhaNota = "";
  if (temNota) {
    linhaNota = await anota(d, conta, quem, String(L.anotacao));
    if (!linhaNota) avisos.push("A anotação não foi salva: mande de novo com \"anotar:\".");
  }

  const tot = custos.length + movs.length + lembs.length + alts.length + pes.length, temRet = rets.length > 0 && custos.length + movs.length + pes.length > 0, ret = usados.size === 1 ? [...usados][0] : "?";
  const msg = (tot ? `✅ <b>Lancei ${tot === 1 ? "1 item" : tot + " itens"}:</b>\n${txt.join("\n")}` : "") +
    (linhaNota ? `${tot ? "\n" : ""}${MSG_ANOTA}${esc(linhaNota)}` : "") +
    (nota && custos.length ? "\n📎 A foto ficou guardada no app junto do custo." : "") +
    (avisos.length ? `\n<i>${esc([...new Set(avisos)].join(" "))}</i>` : "") +
    (L.resposta ? `\n⚠️ ${esc(L.resposta)}` : "") +
    (custos.length === 1 && tot === 1 ? "\nSe o setor estiver errado, toque nele abaixo." : "");
  return responde(d, chat, msg, botoes(base, custos.length === 1 && tot === 1 ? custos[0].id : "", custos[0]?.centro, temRet ? rets : [], ret));
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

// rebanho da fazenda inteira hoje: um fechamento geral (sem retiro) mais novo que os dos retiros conta a fazenda toda;
// senão soma o de cada retiro (cada um com o seu último fechamento) e os movimentos gerais lançados depois
function rebanhoTotal(fechs: any[], movs: any[]) {
  const ok = fechs.filter((f) => f.mes && f.cats), ger = ok.filter((f) => !f.retiro), ret = ok.filter((f) => f.retiro);
  const mg = ger.map((f) => f.mes).sort().pop() || "", mr = ret.map((f) => f.mes).sort().pop() || "";
  if (mg && mg >= mr) return rebanhoHoje(ger, movs);
  const ids = [...new Set(ret.map((f) => f.retiro))];
  if (!ids.length) return null;
  let total = 0, base = "";
  for (const id of ids) {
    const R = rebanhoHoje(ret.filter((f) => f.retiro === id), movs.filter((x) => x.retiro === id));
    if (R) { total += R.total; if (!base || R.mes < base) base = R.mes; }
  }
  movs.filter((x) => !x.retiro || !ids.includes(x.retiro)).filter((x) => String(x.data || "").slice(0, 7) > base).forEach((x) => {
    const n = Number(x.cab) || 0;
    if (x.tipo === "nascimento" || x.tipo === "compra") total += n; else if (x.tipo === "venda" || x.tipo === "morte") total -= n;
  });
  return { mes: base, cats: null as any, total: Math.max(0, Math.round(total)) };
}
/* ---------- grupos dos resumos: um por retiro e o geral (lançamentos sem retiro = da fazenda toda) ---------- */
type Grupo = { nome: string; sem?: boolean; f: (x: any) => boolean };
function grupos(rets: Retiro[], ...listas: any[][]): Grupo[] {
  if (!rets.length) return [{ nome: "", f: () => true }];
  const ids = new Set(rets.map((r) => r.id));
  const G: Grupo[] = rets.map((r) => ({ nome: r.nome, f: (x: any) => x.retiro === r.id }));
  if (listas.some((l) => l.some((x) => !ids.has(x.retiro)))) G.push({ nome: "Geral (fazenda toda)", sem: true, f: (x: any) => !ids.has(x.retiro) });
  return G;
}
const tituloG = (g: Grupo) => (g.nome ? `🏠 <b>${esc(g.sem ? g.nome : "Retiro " + g.nome)}</b>\n` : "");
const somaV = (a: any[]) => a.reduce((s, x) => s + (Number(x.valor) || 0), 0);
// "5 nascimentos · 1 morte · 20 vendidos (R$ ...)"
function rebTxt(movs: any[], comValor: boolean) {
  const cab = (t: string) => movs.filter((x) => x.tipo === t).reduce((a, x) => a + (Number(x.cab) || 0), 0);
  const val = (t: string) => somaV(movs.filter((x) => x.tipo === t));
  return [
    cab("nascimento") && `${nfBR(cab("nascimento"))} ${cab("nascimento") === 1 ? "nascimento" : "nascimentos"}`,
    cab("morte") && `${nfBR(cab("morte"))} ${cab("morte") === 1 ? "morte" : "mortes"}`,
    cab("venda") && `${nfBR(cab("venda"))} vendidos${comValor && val("venda") ? ` (${brl(val("venda"))})` : ""}`,
    cab("compra") && `${nfBR(cab("compra"))} comprados${comValor && val("compra") ? ` (${brl(val("compra"))})` : ""}`,
    cab("transferencia") && `${nfBR(cab("transferencia"))} mudaram de categoria`,
  ].filter(Boolean).join(" · ");
}
const topItens = (gastos: any[], n: number) => {
  const p: Record<string, number> = {};
  gastos.forEach((x) => (p[x.item] = (p[x.item] || 0) + (Number(x.valor) || 0)));
  return Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, n);
};

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
    const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
    const movs = await todos(d, "movimentos", faz), fechs = await todos(d, "fechamentos", faz);
    const semana = movs.filter((x) => x.data >= ini && x.data <= fim);
    const gastos = (await todos(d, "desembolsos", faz, ini)).filter((x) => x.data <= fim);
    const blocos: string[] = [];
    const RT = rebanhoTotal(fechs, movs);
    for (const g of grupos(retirosDe(cfg?.dados), semana, gastos)) {
      const sm = semana.filter(g.f), gs = gastos.filter(g.f), R = g.sem || !g.nome ? null : rebanhoHoje(fechs.filter(g.f), movs.filter(g.f));
      if (g.nome && !sm.length && !gs.length && !R) continue; // retiro sem nada lançado ainda
      const tot = somaV(gs), top = topItens(gs, 3).map(([k, v]) => `${ITN[k] || "Outros"} ${brl(v)}`), reb = rebTxt(sm, true);
      blocos.push(tituloG(g) +
        `🐄 <b>Rebanho:</b> ${reb || "nenhum movimento lançado"}\n` +
        `💸 <b>Custos:</b> ${tot ? brl(tot) + (top.length ? `\n   ${esc(top.join(" · "))}` : "") : "nenhum custo lançado"}` +
        (R ? `\n🐮 <b>Rebanho hoje:</b> ${nfBR(R.total)} cabeças` : ""));
    }
    if (!blocos.length) blocos.push("🐄 <b>Rebanho:</b> nenhum movimento lançado\n💸 <b>Custos:</b> nenhum custo lançado");
    if (blocos.length === 1) blocos[0] = blocos[0].replace(/^🏠 <b>Geral \(fazenda toda\)<\/b>\n/, "");
    const txt = `📊 <b>Resumo da semana</b> · ${dBR(ini).slice(0, 5)} a ${dBR(fim)}${fz?.nome ? "\n" + esc(fz.nome) : ""}\n\n` +
      blocos.join("\n\n") +
      `\n\n📊 <b>Total da fazenda:</b> custos ${brl(somaV(gastos))}${RT ? ` · ${nfBR(RT.total)} cabeças hoje` : ""}` +
      (RT ? `\n<i>Rebanho hoje = último fechamento do mês + movimentos lançados depois.</i>` : "") +
      `\n\nPergunte o que quiser, ex.: <i>quantas vacas eu tenho?</i>`;
    for (const chat of chats) { await d.tg("sendMessage", { chat_id: chat, text: txt, parse_mode: "HTML" }); n++; }
    try { await mandaBackup(d, faz, chats, fz?.nome || ""); } catch (e) { console.error("backup semanal", e); }
  }
  return `enviado para ${n} conversa(s)`;
}

/* ---------- relatório mensal: todo dia 1º, sobre o mês que acabou (vem junto da chamada ?avisos=1 das 7h) ---------- */
const pctTxt = (a: number, b: number) => { if (!b) return ""; const p = (a / b - 1) * 100; return `${p >= 0 ? "+" : ""}${p.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`; };
const gmdTxt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
// so: manda só para uma conversa, na hora (comando "relatório"), sem esperar o dia 1º
export async function relatorioMensal(d: Deps, so?: { faz: string; chat: number }) {
  const hoje = hojeMT(), forcar = !!so;
  if (hoje.slice(8) !== "01" && !forcar) return "só no dia 1º";
  const ini = somaDias(hoje.slice(0, 7) + "-01", -1).slice(0, 7) + "-01", mes = ini.slice(0, 7), fim = somaDias(hoje.slice(0, 7) + "-01", -1);
  const iniAnt = somaDias(ini, -1).slice(0, 7) + "-01", nomeMes = MESF[+mes.slice(5) - 1], nomeAnt = MESF[+iniAnt.slice(5, 7) - 1];
  // uma vez por mês: se alguém chamar de novo, não manda repetido
  if (!forcar) { const { error: ja } = await d.db.from("telegram_updates").insert({ update_id: -Number(mes.replace("-", "")) }); if (ja) return "já enviado"; }
  const porFaz: Record<string, number[]> = {};
  if (so) porFaz[so.faz] = [so.chat];
  else ((await d.db.from("telegram_contas").select("chat_id,fazenda_id")).data || []).forEach((c: any) => (porFaz[c.fazenda_id] ||= []).push(c.chat_id));
  let n = 0;
  for (const [faz, chats] of Object.entries(porFaz)) {
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", faz).maybeSingle();
    const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
    const D = cfg?.dados || {}, rets = retirosDe(D);
    const movs = await todos(d, "movimentos", faz), fechs = await todos(d, "fechamentos", faz);
    const doMes = movs.filter((x) => x.data >= ini && x.data <= fim);
    const gastosT = (await todos(d, "desembolsos", faz, iniAnt)).filter((x) => x.data <= fim);
    const gastos = gastosT.filter((x) => x.data >= ini), gastosAnt = gastosT.filter((x) => x.data < ini);
    const P = D.pesagens || [], Pm = P.filter((p: any) => p.data >= ini && p.data <= fim);
    const blocos: string[] = [], faltaFech: string[] = [];
    const RT = rebanhoTotal(fechs, movs), temGeral = fechs.some((f) => f.mes === mes && !f.retiro);
    for (const g of grupos(rets, doMes, gastosT, Pm)) {
      const dm = doMes.filter(g.f), gs = gastos.filter(g.f), ga = gastosAnt.filter(g.f), R = g.sem || !g.nome ? null : rebanhoHoje(fechs.filter(g.f), movs.filter(g.f));
      const pg = Pm.filter(g.f).sort((a: any, b: any) => (a.data < b.data ? -1 : 1));
      if (g.nome && !g.sem && !temGeral && fechs.some((f) => g.f(f)) && !fechs.some((f) => f.mes === mes && g.f(f))) faltaFech.push(g.nome);
      if (g.nome && !dm.length && !gs.length && !R && !pg.length) continue; // retiro sem nada lançado ainda
      const tot = somaV(gs), totAnt = somaV(ga), invest = somaV(gs.filter((x) => x.tipo === "investimento"));
      const porSetor: Record<string, number> = {};
      gs.forEach((x) => { const s = ONDE[x.centro] ? x.centro : "geral"; porSetor[s] = (porSetor[s] || 0) + (Number(x.valor) || 0); });
      const top = topItens(gs, 5).map(([k, v]) => `   • ${esc(ITN[k] || "Outros")}: ${brl(v)} (${(v / tot * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%)`);
      const setores = Object.keys(ONDE).filter((k) => porSetor[k]).map((k) => `${ONDE[k]} ${brl(porSetor[k])}`);
      const vendas = somaV(dm.filter((x) => x.tipo === "venda")), compras = somaV(dm.filter((x) => x.tipo === "compra")), saldo = vendas - compras - tot;
      const pes = pg.map((p: any) => {
        const a = anterior(P, p.lote, p.data, rets.length ? p.retiro || "" : undefined), nd = a ? dias(a.data, p.data) : 0;
        return `   • ${esc(p.lote)}: ${nfBR(p.peso, 1)} kg em ${dBR(p.data).slice(0, 5)}` + (a && nd ? ` · GMD ${gmdTxt((p.peso - a.peso) / nd)} kg/dia` : "");
      });
      blocos.push(tituloG(g) +
        `🐄 <b>Rebanho no mês:</b> ${rebTxt(dm, false) || "nenhum movimento lançado"}\n` +
        (R ? `   Hoje: <b>${nfBR(R.total)} cabeças</b>\n` : "") +
        `💸 <b>Custos: ${brl(tot)}</b>` + (totAnt ? ` (${pctTxt(tot, totAnt)} sobre ${nomeAnt})` : "") + "\n" +
        (top.length ? top.join("\n") + "\n" : "") +
        (setores.length > 1 || (setores.length === 1 && !porSetor.geral) ? `   Por setor: ${setores.join(" · ")}\n` : "") +
        (invest ? `   Desse total, ${brl(invest)} foram investimento.\n` : "") +
        (vendas || compras ? `💰 <b>Gado:</b>${vendas ? ` vendas ${brl(vendas)}` : ""}${vendas && compras ? " ·" : ""}${compras ? ` compras ${brl(compras)}` : ""}\n` +
          `   Vendas − compras − custos: <b>${brl(saldo)}</b>\n` : "") +
        (pes.length ? `⚖️ <b>Pesagens</b>\n${pes.join("\n")}\n` : ""));
    }
    if (!blocos.length) blocos.push(`🐄 <b>Rebanho no mês:</b> nenhum movimento lançado\n💸 <b>Custos: ${brl(0)}</b>\n`);
    if (blocos.length === 1) blocos[0] = blocos[0].replace(/^🏠 <b>Geral \(fazenda toda\)<\/b>\n/, "");
    if (!fechs.some((f) => f.mes === mes) && !faltaFech.length) faltaFech.push("");
    const totM = somaV(gastos), vendM = somaV(doMes.filter((x) => x.tipo === "venda")), compM = somaV(doMes.filter((x) => x.tipo === "compra"));
    const prox = (D.lembretes || []).filter((x: any) => !x.enviado && x.data.slice(0, 7) === hoje.slice(0, 7)).sort((a: any, b: any) => (a.data < b.data ? -1 : 1))
      .map((x: any) => `   • ${dBR(x.data).slice(0, 5)} · ${esc(x.texto)}`);
    const txt = `📅 <b>Relatório de ${nomeMes} de ${mes.slice(0, 4)}</b>${fz?.nome ? "\n" + esc(fz.nome) : ""}\n\n` +
      blocos.join("\n") +
      `\n📊 <b>Total da fazenda:</b> custos ${brl(totM)}${vendM || compM ? ` · vendas ${brl(vendM)} · compras ${brl(compM)} · saldo <b>${brl(vendM - compM - totM)}</b>` : ""}${RT ? ` · ${nfBR(RT.total)} cabeças hoje` : ""}\n` +
      (prox.length ? `\n⏰ <b>Lembretes de ${MESF[+hoje.slice(5, 7) - 1]}</b>\n${prox.join("\n")}\n` : "") +
      (faltaFech.length ? `\n👉 Falta o <b>fechamento de ${nomeMes}</b> no app${faltaFech[0] ? ` (${esc(faltaFech.join(" e "))})` : ""}: contar o gado e o peso de cada categoria. Com ele saem produção, GMD e lotação do mês.\n` : "") +
      `\nPergunte o que quiser, ex.: <i>qual foi meu maior gasto em ${nomeMes}?</i>`;
    for (const chat of chats) { await d.tg("sendMessage", { chat_id: chat, text: txt, parse_mode: "HTML" }); n++; }
  }
  return `relatório mensal enviado para ${n} conversa(s)`;
}

/* ---------- backup: todos os dados da fazenda num arquivo, pelo Telegram ---------- */
const TAB_BACKUP = ["config", "fechamentos", "movimentos", "desembolsos", "estacoes", "engorda", "insumos", "estoque_movs", "formulacoes", "adaptacoes"];
export async function geraBackup(d: Deps, faz: string) {
  const tabelas: Record<string, any[]> = {}, erros: string[] = [];
  let n = 0;
  for (const t of TAB_BACKUP) {
    const linhas: any[] = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await d.db.from(t).select("*").eq("fazenda_id", faz).range(i, i + 999);
      if (error) { console.error("backup " + t, error); erros.push(t); break; }
      linhas.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    tabelas[t] = linhas;
    if (t !== "config") n += linhas.length;
  }
  const json = JSON.stringify({ app: "Caderno da Fazenda", fazenda_id: faz, gerado_em: new Date().toISOString(), tabelas, ...(erros.length ? { faltou: erros } : {}) });
  return { bytes: new TextEncoder().encode(json), registros: n, erros };
}
async function mandaBackup(d: Deps, faz: string, chats: number[], nomeFaz: string) {
  if (!d.envia || !chats.length) return 0;
  const { bytes, registros, erros } = await geraBackup(d, faz), hoje = hojeMT();
  const slug = (nomeFaz || "fazenda").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "fazenda";
  const legenda = `🔒 <b>Backup da fazenda</b> · ${dBR(hoje)}\n${nfBR(registros)} lançamentos, mais ajustes, anotações, lembretes e pesagens.\n` +
    `Deixe este arquivo guardado aqui no Telegram. Se um dia algo sumir do app, ele traz tudo de volta.` +
    (erros.length ? `\n⚠️ Faltou: ${esc(erros.join(", "))}` : "");
  let n = 0;
  for (const chat of chats) { const r = await d.envia(chat, `backup-${slug}-${hoje}.json`, bytes, legenda); if (r?.ok !== false) n++; }
  return n;
}

/* ---------- lembretes e avisos da arroba (GitHub Actions chama ?avisos=1 às 7h e depois do pregão) ---------- */
export async function avisosDiarios(d: Deps) {
  const hoje = hojeMT();
  const { data: cfgs } = await d.db.from("config").select("fazenda_id,dados");
  const { data: contas } = await d.db.from("telegram_contas").select("chat_id,user_id,fazenda_id");
  // só usa a cotação se for recente (o arquivo do app atualiza nos dias úteis)
  let cot = d.cotacao ? await d.cotacao().catch(() => null) : null;
  if (cot && (!okData(cot.data) || dias(cot.data, hoje) > 5 || !(cot.spot > 0))) cot = null;
  let n = 0;
  for (const c of cfgs || []) {
    if (!c.fazenda_id) continue;
    const D = c.dados || {};
    const lem = (D.lembretes || []).filter((x: any) => !x.enviado && x.data <= hoje);
    const alt = cot ? (D.alertas || []).filter((a: any) => (a.direcao === "abaixo" ? cot!.spot <= a.valor : cot!.spot >= a.valor)) : [];
    const velhos = (D.lembretes || []).some((x: any) => x.enviado && dias(x.enviado, hoje) > LIMPA_ENVIADOS);
    if (!lem.length && !alt.length && !velhos) continue;
    const daFaz = (contas || []).filter((x: any) => x.fazenda_id === c.fazenda_id);
    // vai para quem pediu; se ele não tiver mais o Telegram ligado, vai para os outros sócios
    const para = (uid: string) => { const s = daFaz.filter((x: any) => x.user_id === uid); return (s.length ? s : daFaz).map((x: any) => x.chat_id); };
    const enviados = new Set<string>();
    for (const x of lem) {
      const t = `⏰ <b>Lembrete</b> · ${dBR(hoje)}\n${esc(x.texto)}` + (x.data < hoje ? `\n<i>era para ${dBR(x.data)}</i>` : "") + (x.por ? `\n<i>marcado por ${esc(x.por)}</i>` : "");
      const cs = para(x.porId);
      for (const chat of cs) { await d.tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML" }); n++; }
      if (cs.length) enviados.add(x.id);
    }
    for (const a of alt) {
      const t = `📈 <b>Arroba do boi gordo: ${brl(cot!.spot)}</b>\n${a.direcao === "abaixo" ? "Caiu abaixo" : "Passou"} de ${brl(a.valor)}, como você pediu.\n<i>B3 à vista, pregão de ${dBR(cot!.data)}. A cotação da sua região costuma ser diferente.</i>`;
      const cs = para(a.porId);
      for (const chat of cs) { await d.tg("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML" }); n++; }
      if (cs.length) enviados.add(a.id);
    }
    await mudaCfg(d, c.fazenda_id, (X) => ({ ...X,
      lembretes: (X.lembretes || []).map((x: any) => (enviados.has(x.id) ? { ...x, enviado: hoje } : x))
        .filter((x: any) => !(x.enviado && dias(x.enviado, hoje) > LIMPA_ENVIADOS)),
      alertas: (X.alertas || []).filter((a: any) => !enviados.has(a.id)) }));
  }
  return `${n} aviso(s) enviados`;
}
// "lembretes": lista o que está marcado, com botão para cancelar
async function listaLembretes(d: Deps, faz: string) {
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const L = (cfg?.dados?.lembretes || []).filter((x: any) => !x.enviado).sort((a: any, b: any) => (a.data < b.data ? -1 : 1));
  const A = cfg?.dados?.alertas || [];
  if (!L.length && !A.length) return { text: "Nenhum lembrete nem aviso da arroba marcado.\n\nPara marcar, mande por exemplo:\n• <i>lembrar: vacina da aftosa dia 15/11</i>\n• <i>me avisa quando o boi passar de 320</i>", extra: {} };
  const itens = [...L, ...A];
  const linhas = [
    ...(L.length ? ["⏰ <b>Lembretes</b>", ...L.map((x: any, i: number) => `${i + 1}. ${dBR(x.data)} · ${esc(x.texto)}${x.por ? ` <i>(${esc(x.por)})</i>` : ""}`)] : []),
    ...(A.length ? [`${L.length ? "\n" : ""}📈 <b>Avisos da arroba</b>`, ...A.map((a: any, i: number) => `${L.length + i + 1}. quando o boi gordo ${a.direcao === "abaixo" ? "cair abaixo de" : "passar de"} ${brl(a.valor)}`)] : []),
    "\nPara cancelar, toque no número.",
  ];
  const bts = itens.map((x: any, i: number) => ({ text: `❌ ${i + 1}`, callback_data: `canc:${x.id}` }));
  const kb: any[][] = []; for (let i = 0; i < bts.length; i += 5) kb.push(bts.slice(i, i + 5));
  return { text: linhas.join("\n"), extra: { reply_markup: { inline_keyboard: kb } } };
}

/* ---------- perguntas sobre os dados ---------- */
export async function contexto(d: Deps, faz: string) {
  const hoje = hojeMT(), desde = somaDias(hoje, -730);
  const movs = await todos(d, "movimentos", faz), fechs = await todos(d, "fechamentos", faz), gastos = await todos(d, "desembolsos", faz, desde);
  const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", faz).maybeSingle();
  const notas = cfg?.dados?.notas || {}, rets = retirosDe(cfg?.dados);
  const CN = (k: string) => CATS[k] || k || "";
  // retiro de cada lançamento; sem retiro = da fazenda toda (geral)
  const RN = (x: any) => (rets.length ? rets.find((r) => r.id === x.retiro)?.nome || "fazenda toda" : "");
  const G: Grupo[] = [...grupos(rets).filter((g) => !g.sem && g.nome), { nome: "Fazenda toda (total)", sem: true, f: () => true }];
  const reb = G.map((g) => {
    const R: any = g.sem ? rebanhoTotal(fechs, movs) : rebanhoHoje(fechs.filter(g.f), movs.filter(g.f));
    const nome = `${g.sem ? "fazenda toda (total)" : "retiro " + g.nome}: `;
    return R ? `${nome}total ${R.total} cabeças (fechamento de ${R.mes} + movimentos depois)` +
      (R.cats ? "; " + Object.entries(R.cats).filter(([, v]) => v).map(([k, v]) => `${CN(k)} ${v}`).join("; ") : "") : `${nome}nenhum fechamento de mês lançado ainda`;
  });
  const linhas = [
    `Hoje: ${hoje}. 1 @ = ${Number(cfg?.dados?.kgArroba) || 30} kg de peso vivo.`,
    ...(rets.length ? [`RETIROS: a fazenda é dividida em ${rets.map((r) => r.nome).join(" e ")}, cada um com seu gado e suas contas (donos diferentes). Lançamentos marcados "fazenda toda" são gerais, de nenhum retiro. Se a pergunta citar um retiro (ex.: "dados Santa Helena", "quanto gastei no Santa Faustina"), responda só com os dados daquele retiro. Se não citar retiro, responda com a fazenda toda: tudo somado (os retiros e os gerais).`] : []),
    "REBANHO HOJE:",
    ...reb,
    `FECHAMENTOS DO MÊS (${rets.length ? "retiro; " : ""}mês: categoria cabeças/peso médio kg):`,
    ...[...fechs].sort((a, b) => (a.mes < b.mes ? -1 : 1)).slice(-26).map((f) => (rets.length ? RN(f) + "; " : "") + `${f.mes}: ` +
      Object.entries(f.cats || {}).map(([k, v]: any) => `${CN(k)} ${v.cab}/${v.peso || "?"}kg`).join("; ")),
    "MOVIMENTOS (data;tipo;categoria;para;cabeças;peso médio kg;valor R$;obs;quem;retiro):",
    ...movs.filter((x) => x.data >= desde).sort((a, b) => (a.data < b.data ? -1 : 1)).map((x) =>
      [x.data, TIPOS_MOV[x.tipo] || x.tipo, CN(x.categoria), x.para ? CN(x.para) : "", x.cab, x.pesoMedio || "", x.valor || "", x.obs || "", x.por || "", RN(x)].join(";")),
    "CUSTOS, últimos 2 anos (data;tipo de custo;setor;valor R$;descrição;custeio ou investimento;retiro):",
    ...gastos.sort((a, b) => (a.data < b.data ? -1 : 1)).map((x) =>
      [x.data, ITN[x.item] || x.item || "", ONDE[x.centro] || "Fazenda toda", x.valor, x.descricao || "", x.tipo || "custeio", RN(x)].join(";")),
    "BLOCO DE NOTAS (mês: texto):",
    ...Object.keys(notas).sort().slice(-12).map((m) => `${m}: ${String(notas[m]).replace(/\s*\n\s*/g, " | ")}`),
    "PESAGENS (data;lote;cabeças;peso médio kg;retiro) — GMD = diferença de peso ÷ dias entre pesagens do mesmo lote e retiro:",
    ...[...(cfg?.dados?.pesagens || [])].filter((p: any) => p.data >= desde).sort((a: any, b: any) => (a.data < b.data ? -1 : 1)).map((p: any) => [p.data, p.lote, p.cab || "", p.peso, RN(p)].join(";")),
    "LEMBRETES MARCADOS (dia;texto):",
    ...(cfg?.dados?.lembretes || []).filter((x: any) => !x.enviado).map((x: any) => `${x.data};${x.texto}`),
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

/* ---------- botões (Desfazer / trocar setor / trocar retiro) ---------- */
// marca com "• " o botão escolhido de uma fileira (setor ou retiro), mantendo os outros botões da mensagem
const marca = (markup: any, prefixo: string, escolhido: string) => (markup?.inline_keyboard || []).map((fila: any[]) => fila.map((b: any) =>
  String(b.callback_data || "").startsWith(prefixo) ? { ...b, text: (b.callback_data === escolhido ? "• " : "") + String(b.text).replace(/^• /, "") } : b));
async function botao(d: Deps, q: any) {
  const chat = q.message?.chat?.id, [acao, id, onde] = String(q.data || "").split(":");
  const { data: conta } = await d.db.from("telegram_contas").select("user_id,fazenda_id").eq("chat_id", chat).maybeSingle();
  const fim = (t: string) => d.tg("answerCallbackQuery", { callback_query_id: q.id, text: t });
  if (!conta) return fim("Telegram não está ligado ao app.");
  if (acao === "desf" && /^[0-9a-f-]{36}$/.test(id)) {
    const { data: cs } = await d.db.from("desembolsos").delete().eq("fazenda_id", conta.fazenda_id).like("id", id + "-%").select("id");
    const { data: ms } = await d.db.from("movimentos").delete().eq("fazenda_id", conta.fazenda_id).like("id", id + "-%").select("id");
    const t = String(q.message?.text || ""), i = t.indexOf(MSG_ANOTA);
    const tirouNota = i >= 0 ? await desanota(d, conta, t.slice(i + MSG_ANOTA.length).split("\n")[0].trim()) : false;
    const tirou: Record<string, number> = {};
    await mudaCfg(d, conta.fazenda_id, (D) => {
      for (const k of ["lembretes", "alertas", "pesagens"]) {
        const a = D[k] || [], b = a.filter((x: any) => !String(x.id || "").startsWith(id + "-"));
        tirou[k] = a.length - b.length; if (tirou[k]) D[k] = b;
      }
      return Object.values(tirou).some(Boolean) ? D : null;
    });
    const nc = cs?.length || 0, nm = ms?.length || 0, pl = (n: number, um: string, v: string) => n && (n === 1 ? "1 " + um : n + " " + v);
    const partes = [pl(nc, "custo", "custos"), pl(nm, "movimento do rebanho", "movimentos do rebanho"), pl(tirou.lembretes, "lembrete", "lembretes"),
      pl(tirou.alertas, "aviso da arroba", "avisos da arroba"), pl(tirou.pesagens, "pesagem", "pesagens"), tirouNota && "a anotação"].filter(Boolean) as string[];
    if (!partes.length) return fim("Esse lançamento já não existe.");
    const lista = partes.length > 1 ? partes.slice(0, -1).join(", ") + " e " + partes.at(-1) : partes[0];
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `↩ Desfeito: tirei do app ${lista}.` });
    return fim("Desfeito");
  }
  if (acao === "ret" && /^[0-9a-f-]{36}$/.test(id) && /^[\w-]{1,20}$/.test(onde)) {
    const { data: cfg } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
    const r = onde === "geral" ? { id: "", nome: GERAL } : retirosDe(cfg?.dados).find((x) => x.id === onde);
    if (!r) return fim("Esse retiro não existe mais.");
    const troca = (dd: any) => { const o = { ...dd }; if (r.id) o.retiro = r.id; else delete o.retiro; return o; };
    let n = 0;
    for (const tab of ["desembolsos", "movimentos"]) {
      const { data: rows } = await d.db.from(tab).select("id,dados").eq("fazenda_id", conta.fazenda_id).like("id", id + "-%");
      for (const x of rows || []) { await d.db.from(tab).update({ dados: troca(x.dados) }).eq("fazenda_id", conta.fazenda_id).eq("id", x.id); n++; }
    }
    await mudaCfg(d, conta.fazenda_id, (D) => {
      let m = 0;
      const p = (D.pesagens || []).map((x: any) => (String(x.id || "").startsWith(id + "-") ? (m++, troca(x)) : x));
      n += m; return m ? { ...D, pesagens: p } : null;
    });
    if (!n) return fim("Esse lançamento já não existe.");
    const t = String(q.message?.text || "").replace(/🏠 [^\n]*/g, "🏠 " + r.nome);
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: t,
      reply_markup: { inline_keyboard: marca(q.message.reply_markup, `ret:${id}:`, `ret:${id}:${r.id || "geral"}`) } });
    return fim(r.id ? "Agora no retiro " + r.nome : "Agora na fazenda toda");
  }
  if (acao === "canc" && /^[0-9a-f-]{36}-[la]\d+$/.test(id)) {
    let achou = false;
    await mudaCfg(d, conta.fazenda_id, (D) => {
      for (const k of ["lembretes", "alertas"]) {
        const a = D[k] || [], b = a.filter((x: any) => x.id !== id);
        if (b.length !== a.length) { D[k] = b; achou = true; }
      }
      return achou ? D : null;
    });
    const L = await listaLembretes(d, conta.fazenda_id);
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: L.text, parse_mode: "HTML", ...L.extra });
    return fim(achou ? "Cancelado" : "Já não estava marcado.");
  }
  // botões de mensagens antigas (antes de juntar tudo numa mensagem)
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
    const kb = { reply_markup: { inline_keyboard: marca(q.message.reply_markup, `onde:${id}:`, `onde:${id}:${onde}`) } };
    await d.tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: t, ...kb });
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
  const chat = msg.chat.id, nomeTg = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  let texto = String(msg.text || msg.caption || "").trim();
  const cod = texto.match(/^(?:\/start\s+)?(\d{6})$/);
  if (cod) return liga(d, chat, cod[1], nomeTg);
  const { data: conta } = await d.db.from("telegram_contas").select("user_id,fazenda_id").eq("chat_id", chat).maybeSingle();
  if (!conta) return responde(d, chat, "Olá! Para usar o robô, ligue seu Telegram pelo app: <b>Mais → Sócios → Conectar meu Telegram</b>. Depois mande aqui o código de 6 números.");
  if (/^\/(start|ajuda|help)\b/i.test(texto)) return responde(d, chat, AJUDA);
  const { data: m } = await d.db.from("membros").select("nome,email").eq("fazenda_id", conta.fazenda_id).eq("user_id", conta.user_id).maybeSingle();
  if (!m) return responde(d, chat, "Você não faz mais parte desta fazenda no app. Peça para um sócio te convidar de novo.");
  const quem = m.nome || String(m.email || "").split("@")[0] || nomeTg || "sócio";

  // áudio: vira texto e segue igual a uma mensagem escrita
  const audio = msg.voice || msg.audio;
  if (audio) {
    if (!d.transcreve) return responde(d, chat, "Ainda não entendo áudio: falta ligar a transcrição (chave da OpenAI). Por enquanto, mande por escrito.");
    if ((audio.duration || 0) > 180) return responde(d, chat, "Áudio muito longo. Mande áudios de até 3 minutos.");
    const f = await d.tg("getFile", { file_id: audio.file_id });
    if (!f?.ok) return responde(d, chat, "Não consegui baixar o áudio. Tente mandar de novo.");
    await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
    const ext = (String(f.result.file_path).match(/\.(\w+)$/)?.[1] || "ogg").replace(/^oga$/, "ogg");
    const ouvido = (await d.transcreve(await d.baixa(f.result.file_path), `audio.${ext}`))?.trim();
    if (!ouvido) return responde(d, chat, "Não consegui entender o áudio. Tente de novo falando mais perto do celular, ou mande por escrito.");
    await responde(d, chat, `🎤 <i>${esc(ouvido)}</i>`);
    texto = ouvido;
  }

  // comandos que não gastam com a inteligência artificial
  const cmd = texto.toLowerCase().replace(/[.!?]+$/, "").trim();
  if (!msg.photo && !msg.document && /^\/?(meus |ver )?(lembretes|avisos|alertas)$/.test(cmd)) {
    const L = await listaLembretes(d, conta.fazenda_id);
    return responde(d, chat, L.text, L.extra);
  }
  if (!msg.photo && !msg.document && /^\/?(manda o |mandar o |quero o |ver o )?relat[oó]rio( mensal| do m[eê]s( passado)?)?$/.test(cmd)) {
    await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
    await relatorioMensal(d, { faz: conta.fazenda_id, chat });
    return;
  }
  if (!msg.photo && !msg.document && /^\/?(fazer |quero o |manda o |mandar o )?backup$/.test(cmd)) {
    if (!d.envia) return responde(d, chat, "O backup ainda não está ligado.");
    await d.tg("sendChatAction", { chat_id: chat, action: "upload_document" });
    const { data: fz } = await d.db.from("fazendas").select("nome").eq("id", conta.fazenda_id).maybeSingle();
    const n = await mandaBackup(d, conta.fazenda_id, [chat], fz?.nome || "");
    return n ? undefined : responde(d, chat, "Não consegui gerar o backup agora. Tente de novo em instantes.");
  }

  // anotação direta, sem gastar com a inteligência artificial
  // (no áudio a transcrição costuma escrever "Anotar, ..." ou "Anota ...")
  const an = texto.match(/^(?:anotar|anota|nota)\s*[:\-]\s*([\s\S]+)/i) || (audio ? texto.match(/^(?:anotar|anota)(?:\s*[,.:\-]\s*|\s+)([\s\S]+)/i) : null);
  if (an && !msg.photo && !msg.document) return lancaNota(d, chat, conta, quem, an[1]);

  // pergunta direta (termina com "?"): não precisa classificar antes
  if (texto.endsWith("?") && !msg.photo && !msg.document) return respondePergunta(d, chat, conta, texto);

  const conteudo: any[] = [];
  const foto = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
  const doc = msg.document && /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(msg.document.mime_type || "") ? msg.document : null;
  let arquivo: Uint8Array | null = null, tipoArq = "";
  if (foto || doc) {
    const f = await d.tg("getFile", { file_id: (foto || doc).file_id });
    if (!f?.ok) return responde(d, chat, "Não consegui baixar o arquivo. Tente mandar de novo.");
    arquivo = await d.baixa(f.result.file_path);
    tipoArq = doc ? doc.mime_type : "image/jpeg";
    const dados = b64(arquivo);
    conteudo.push(tipoArq === "application/pdf" ? { type: "document", source: { type: "base64", media_type: tipoArq, data: dados } }
      : { type: "image", source: { type: "base64", media_type: tipoArq, data: dados } });
  } else if (!texto) {
    return responde(d, chat, AJUDA);
  }
  const { data: cfgT } = await d.db.from("config").select("dados").eq("fazenda_id", conta.fazenda_id).maybeSingle();
  const retsT = retirosDe(cfgT?.dados);
  conteudo.push({ type: "text", text: `Hoje é ${hojeMT()}.` + (retsT.length ? `\nRetiros da fazenda: ${retsT.map((r) => r.nome).join(", ")}.` : "") +
    (texto ? `\nMensagem: ${texto}` : "\n(só a imagem)") });
  await d.tg("sendChatAction", { chat_id: chat, action: "typing" });
  const L = await d.le(conteudo);
  if (!L) return responde(d, chat, "Não consegui ler agora. Tente de novo em instantes ou lance pelo app.");
  if (L.tipo === "pergunta" && texto) return respondePergunta(d, chat, conta, texto);
  const temCusto = (L.custos || []).some((c) => Number(c.valor) > 0);
  return lanca(d, chat, conta, quem, L, arquivo && temCusto ? await guardaNota(d, conta.fazenda_id, arquivo, tipoArq) : "");
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
  // fotos das notas: pasta privada "notas" do Storage (criada na primeira vez); só a função lê e grava
  const guarda = async (caminho: string, bytes: Uint8Array, tipo: string) => {
    const sobe = () => db.storage.from("notas").upload(caminho, bytes, { contentType: tipo, upsert: false });
    let { error } = await sobe();
    if (error && /not.?found/i.test(error.message)) {
      await db.storage.createBucket("notas", { public: false, fileSizeLimit: 10 * 1024 * 1024 });
      ({ error } = await sobe());
    }
    if (error) console.error("guardar nota", error);
    return !error;
  };
  const link = async (caminho: string) => {
    const { data, error } = await db.storage.from("notas").createSignedUrl(caminho, 3600);
    if (error) console.error("link nota", error);
    return data?.signedUrl || null;
  };
  const usuario = async (jwt: string) => { const { data } = await db.auth.getUser(jwt); return data?.user?.id || null; };
  // áudio → texto pela OpenAI (segredo OPENAI_API_KEY); sem a chave, o robô avisa que ainda não entende áudio
  const chaveOpenAI = Deno.env.get("OPENAI_API_KEY") || "";
  const transcreve = chaveOpenAI ? async (bytes: Uint8Array, nome: string) => {
    try {
      const fd = new FormData();
      fd.append("file", new Blob([bytes]), nome);
      fd.append("model", "gpt-4o-mini-transcribe");
      fd.append("language", "pt");
      fd.append("prompt", "Pecuária de corte em Mato Grosso. Palavras comuns: bezerros, matrizes, vacas, novilhas, garrotes, boi gordo, boi magro, arroba, desmama, IATF, DDG, núcleo, sal mineral, proteinado, cria, recria, engorda, confinamento, TIP, diesel. Valores em reais.");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${chaveOpenAI}` }, body: fd });
      if (!r.ok) { console.error("transcrição", r.status, await r.text()); return null; }
      return (await r.json()).text || null;
    } catch (e) { console.error("transcrição", e); return null; }
  } : undefined;
  const envia = async (chat: number, nome: string, bytes: Uint8Array, legenda: string) => {
    const fd = new FormData();
    fd.append("chat_id", String(chat)); fd.append("caption", legenda); fd.append("parse_mode", "HTML");
    fd.append("document", new Blob([bytes], { type: "application/json" }), nome);
    const r = await (await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: fd })).json();
    if (!r?.ok) console.error("sendDocument", r);
    return r;
  };
  // mesma cotação que o app mostra (o GitHub atualiza cotacoes.json nos dias úteis)
  const cotacao = async () => {
    const r = await fetch("https://raw.githubusercontent.com/drhigorfreitas-design/caderno-da-fazenda/main/cotacoes.json", { cache: "no-store" });
    if (!r.ok) return null;
    const b = (await r.json())?.boi;
    return b?.spot > 0 && b?.data ? { data: String(b.data), spot: Number(b.spot) } : null;
  };
  const deps: Deps = { token, tg, baixa, le, pensa, db, guarda, link, usuario, transcreve, envia, cotacao };
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, apikey, x-client-info", "access-control-allow-methods": "POST, OPTIONS" };

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
    if (url.searchParams.has("nota")) {
      // chamado pelo app (formulário de custo): guarda a foto e, se pedido, lê a nota
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      let r = { status: 500, json: { erro: "Erro no servidor. Tente de novo." } as any };
      try {
        const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        r = await notaApp(deps, url.searchParams.get("nota") || "", jwt, await req.json());
      } catch (e) { console.error("nota", e); }
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }
    if (url.searchParams.has("resumo")) {
      // chamado toda segunda pelo GitHub Actions; manda no máximo uma vez por semana
      try { return new Response(await resumoSemanal(deps)); } catch (e) { console.error("resumo", e); return new Response("erro", { status: 500 }); }
    }
    if (url.searchParams.has("avisos")) {
      // chamado todo dia pelo GitHub Actions: lembretes do dia e avisos de preço da arroba
      // no dia 1º, manda antes o relatório do mês que acabou
      let mensal = "";
      try { mensal = await relatorioMensal(deps); } catch (e) { console.error("relatório mensal", e); mensal = "erro no relatório mensal"; }
      try { return new Response(`${await avisosDiarios(deps)} · ${mensal}`); } catch (e) { console.error("avisos", e); return new Response("erro", { status: 500 }); }
    }
    if (req.method !== "POST" || req.headers.get("x-telegram-bot-api-secret-token") !== segredo) return new Response("ok");
    try { await trata(deps, await req.json()); } catch (e) { console.error("falha", e); }
    return new Response("ok");
  });
}
